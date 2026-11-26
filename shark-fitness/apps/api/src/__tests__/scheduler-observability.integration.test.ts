import { desc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db, schema, sqlite } from '../db/client.js';
import { jobsForTest, runScheduledJob, scheduledJobs } from '../jobs/scheduler.js';
import { setErrorReporterForTest, type ErrorReportContext, type ErrorReporter } from '../lib/error-reporting.js';
import { renderMetrics, resetMetricsForTest } from '../lib/metrics.js';
import { id } from '../lib/ids.js';
import { DAY, MINUTE, localClockOnDay, now } from '../lib/time.js';

afterEach(() => {
  sqlite.exec('DROP TRIGGER IF EXISTS fail_job_completion_probe');
  setErrorReporterForTest(null);
});

describe('scheduler failure reporting', () => {
  it('reports a throwing job exactly once, tagged with the job, and records the failed run', () => {
    const captures: Array<{ error: unknown; context: ErrorReportContext }> = [];
    const recording: ErrorReporter = {
      name: 'console',
      capture: (error, context) => captures.push({ error, context }),
      flush: async () => undefined,
    };
    setErrorReporterForTest(recording);
    resetMetricsForTest();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const job = {
      name: 'probe-failing-job',
      everyMs: MINUTE,
      run: () => {
        throw new Error('probe job could not finish');
      },
    };

    try {
      expect(() => runScheduledJob(job)).not.toThrow();

      expect(captures).toHaveLength(1);
      expect(captures[0]!.context).toEqual({ job: 'probe-failing-job', source: 'scheduler' });
      expect((captures[0]!.error as Error).message).toBe('probe job could not finish');

      const rows = db.select().from(schema.jobRuns).where(eq(schema.jobRuns.job, 'probe-failing-job')).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'failed', error: 'probe job could not finish', errorCategory: 'Error' });
      expect(renderMetrics({ jobLastSuccess: [], outboxUndelivered: 0, sqliteDbSizeBytes: 0, dataFilesystem: null, release: 'test' }))
        .toContain('job_runs_total{job="probe-failing-job",outcome="failure"} 1');
    } finally {
      consoleError.mockRestore();
      db.delete(schema.jobRuns).where(eq(schema.jobRuns.job, 'probe-failing-job')).run();
    }
  });

  it('reports nothing for a job that succeeds', () => {
    const captures: unknown[] = [];
    setErrorReporterForTest({ name: 'console', capture: (error) => captures.push(error), flush: async () => undefined });
    try {
      runScheduledJob({ name: 'probe-passing-job', everyMs: MINUTE, run: () => ({ done: 1 }) });
      expect(captures).toEqual([]);
      expect(db.select().from(schema.jobRuns).where(eq(schema.jobRuns.job, 'probe-passing-job')).get()?.status).toBe('succeeded');
    } finally {
      db.delete(schema.jobRuns).where(eq(schema.jobRuns.job, 'probe-passing-job')).run();
    }
  });
});

describe('durable scheduler execution history', () => {
  it('records the actual completion state and duration of a job', () => {
    const startedAt = now();
    const ticks = [startedAt, startedAt + 17];
    jobsForTest.execute('deliver-automation-queue', () => ticks.shift()!);

    const row = db
      .select()
      .from(schema.jobRuns)
      .where(eq(schema.jobRuns.startedAt, startedAt))
      .get()!;
    expect(row.status).toBe('succeeded');
    expect(row.startedAt).toBe(startedAt);
    expect(row.finishedAt).toBe(startedAt + 17);
    expect(row.durationMs).toBe(17);
    expect(row.summary).toMatchObject({ processed: expect.any(Number) });
    expect(row.buildId).toBeTruthy();
    expect(scheduledJobs().find((job) => job.name === row.job)).toMatchObject({
      status: 'succeeded',
      durationMs: 17,
      health: 'healthy',
      lastSuccessfulRunAt: new Date(startedAt + 17).toISOString(),
      nextExpectedAt: new Date(startedAt + MINUTE).toISOString(),
    });
  });

  it('persists a failure instead of only printing it to stderr', () => {
    sqlite.exec(`CREATE TRIGGER fail_job_completion_probe
      BEFORE UPDATE ON job_runs WHEN NEW.status = 'succeeded'
      BEGIN SELECT RAISE(ABORT, 'forced job completion failure'); END`);
    const startedAt = now();
    const ticks = [startedAt, startedAt + 9, startedAt + 10];

    expect(() => jobsForTest.execute('deliver-automation-queue', () => ticks.shift()!)).toThrow(/forced job completion failure/);

    const row = db
      .select()
      .from(schema.jobRuns)
      .where(eq(schema.jobRuns.startedAt, startedAt))
      .get()!;
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/forced job completion failure/);
    expect(row.errorCategory).toBeTruthy();
    expect(row.durationMs).toBe(10);
  });

  it('marks the automation job failed when an individual rule cannot be planned', () => {
    const automationId = id('atm');
    const atMs = now();
    db.insert(schema.automations).values({
      id: automationId,
      tenantId: 'ten_shark',
      name: 'Broken scheduler probe',
      trigger: 'not.a.real.trigger',
      description: '',
      conditions: [],
      actions: [{ kind: 'in_app', templateCode: null, delayMin: 0 }],
      branchIds: null,
      quietHours: null,
      state: 'active',
      dryRun: false,
      runsLast30: 0,
      lastRunAt: null,
      createdAt: atMs,
      updatedAt: atMs,
    }).run();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      expect(() => jobsForTest.execute('run-automations')).toThrow(/automation/i);
      const row = db.select().from(schema.jobRuns).where(eq(schema.jobRuns.job, 'run-automations'))
        .orderBy(desc(schema.jobRuns.startedAt)).get()!;
      expect(row.status).toBe('failed');
      expect(row.error).toMatch(/automation/i);
    } finally {
      error.mockRestore();
      db.delete(schema.automations).where(eq(schema.automations.id, automationId)).run();
    }
    // This runs every active automation over the whole shared test database,
    // whose size depends on which suites ran first (about 200 expiring-
    // membership recipients across several copies of that automation once the
    // P05 suites have added their members): over the 5 s default on a loaded
    // machine, though the assertions are unchanged.
  }, 30_000);

  it('marks stale execution evidence overdue and reports an intentionally disabled scheduler', () => {
    const atMs = now() + 365 * DAY;
    const runId = id('jobr');
    db.insert(schema.jobRuns).values({
      id: runId,
      job: 'deliver-automation-queue',
      startedAt: atMs - 6 * MINUTE,
      finishedAt: atMs - 6 * MINUTE + 5,
      status: 'succeeded',
      durationMs: 5,
      error: null,
    }).run();

    try {
      expect(scheduledJobs(atMs, false).find((job) => job.name === 'deliver-automation-queue')).toMatchObject({
        status: 'overdue',
        health: 'stale',
        error: expect.stringMatching(/No run observed/),
      });
      expect(scheduledJobs(atMs, true).every((job) => job.status === 'disabled' && job.health === 'disabled')).toBe(true);
    } finally {
      db.delete(schema.jobRuns).where(eq(schema.jobRuns.id, runId)).run();
    }
  });

  it('keeps a long visit open until that branch actually closes', () => {
    const branchId = id('br');
    const checkInId = id('chk');
    const enteredAt = localClockOnDay('2026-03-09', '08:00', 'America/New_York');
    const beforeClose = localClockOnDay('2026-03-09', '21:30', 'America/New_York');
    const afterClose = localClockOnDay('2026-03-09', '22:01', 'America/New_York');
    const memberId = db.select({ id: schema.members.id }).from(schema.members).where(eq(schema.members.tenantId, 'ten_shark')).get()!.id;

    db.insert(schema.branches).values({
      id: branchId,
      tenantId: 'ten_shark',
      name: 'Closing time probe',
      slug: `closing-${branchId}`,
      addressLine: '1 Test Street',
      city: 'New York',
      timezone: 'America/New_York',
      capacity: 10,
      opensMinutes: 6 * 60,
      closesMinutes: 22 * 60,
      state: 'active',
      amenities: [],
      holidays: [],
      hours: { mon: { open: 6 * 60, close: 22 * 60, closed: false } },
      policy: {},
      createdAt: enteredAt,
      updatedAt: enteredAt,
    }).run();
    db.insert(schema.checkIns).values({
      id: checkInId,
      tenantId: 'ten_shark',
      branchId,
      memberId,
      method: 'desk',
      decision: 'granted',
      enteredAt,
      exitedAt: null,
      autoClosed: false,
      overrideById: null,
      overrideByName: null,
      overrideReason: null,
      visitNumber: null,
    }).run();

    try {
      jobsForTest.closeStaleCheckIns(beforeClose);
      expect(db.select().from(schema.checkIns).where(eq(schema.checkIns.id, checkInId)).get()?.exitedAt).toBeNull();

      jobsForTest.closeStaleCheckIns(afterClose);
      expect(db.select().from(schema.checkIns).where(eq(schema.checkIns.id, checkInId)).get()).toMatchObject({
        exitedAt: afterClose,
        autoClosed: true,
      });
    } finally {
      db.delete(schema.checkIns).where(eq(schema.checkIns.id, checkInId)).run();
      db.delete(schema.branches).where(eq(schema.branches.id, branchId)).run();
    }
  });
});
