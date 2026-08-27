import { performance } from 'node:perf_hooks';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const TARGET_MEMBERS = 5_000;
const SAMPLES = 20;
const WARMUPS = 2;
const repository = process.cwd();
const root = mkdtempSync(join(tmpdir(), 'shark-performance-'));
const databasePath = join(root, 'performance.db');
const requireFromApi = createRequire(resolve(repository, 'apps/api/package.json'));
const Database = requireFromApi('better-sqlite3');
const baseEnvironment = {
  ...process.env,
  SHARK_PASS_SECRET: 'performance-baseline-pass-secret-with-at-least-48-bytes',
  SHARK_DEMO_READER_KEY: 'performance-baseline-reader-secret',
  SHARK_RELEASE: 'performance-baseline',
};

function pnpmInvocation(args) {
  return process.env.npm_execpath
    ? { command: process.execPath, args: [process.env.npm_execpath, ...args] }
    : { command: 'pnpm', args };
}

function runPnpm(args, environment) {
  const invocation = pnpmInvocation(args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repository,
    env: { ...baseEnvironment, ...environment },
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed with exit code ${String(result.status)}.`);
}

function isoDay(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function buildDataset() {
  const database = new Database(databasePath);
  const prepared = new Map();
  const insertClone = (table, template, overrides) => {
    const row = { ...template, ...overrides };
    const columns = Object.keys(row);
    const cacheKey = `${table}:${columns.join(',')}`;
    let statement = prepared.get(cacheKey);
    if (!statement) {
      statement = database.prepare(`insert into ${table} (${columns.map((column) => `\`${column}\``).join(',')}) values (${columns.map(() => '?').join(',')})`);
      prepared.set(cacheKey, statement);
    }
    statement.run(...columns.map((column) => row[column]));
  };

  try {
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = OFF');
    const tenantId = database.prepare("select id from tenants where slug = 'shark'").get().id;
    const branches = database.prepare('select id from branches where tenant_id = ? order by id').all(tenantId).map((row) => row.id);
    const existingMembers = database.prepare('select count(*) as count from members where tenant_id = ? and deleted_at is null').get(tenantId).count;
    const memberTemplate = database.prepare('select * from members where tenant_id = ? and user_id is null limit 1').get(tenantId);
    const membershipTemplate = database.prepare("select * from memberships where tenant_id = ? and product_id = 'prd_elite_annual' limit 1").get(tenantId)
      ?? database.prepare("select * from memberships where tenant_id = ? and state = 'active' limit 1").get(tenantId);
    const invoiceTemplate = database.prepare('select * from invoices where tenant_id = ? limit 1').get(tenantId);
    const paymentTemplate = database.prepare("select * from payments where tenant_id = ? and state = 'succeeded' limit 1").get(tenantId)
      ?? database.prepare('select * from payments where tenant_id = ? limit 1').get(tenantId);
    const bookingTemplate = database.prepare('select * from bookings where tenant_id = ? limit 1').get(tenantId);
    const checkInTemplate = database.prepare('select * from check_ins where tenant_id = ? limit 1').get(tenantId);
    const ticketTemplate = database.prepare('select * from tickets where tenant_id = ? limit 1').get(tenantId);
    const ledgerTemplate = database.prepare('select * from stock_ledger where tenant_id = ? limit 1').get(tenantId);
    const sessions = database.prepare(`select id, starts_at, ends_at, capacity, booked
      from class_sessions where tenant_id = ? and state != 'cancelled' and booked < capacity order by starts_at`).all(tenantId);
    const addCount = Math.max(0, TARGET_MEMBERS - existingMembers);
    const generatedMemberIds = [];
    const now = Date.now();
    let sessionCursor = 0;
    const sessionAdds = new Map();

    database.transaction(() => {
      for (let index = 0; index < addCount; index += 1) {
        const ordinal = existingMembers + index + 1;
        const suffix = String(ordinal).padStart(5, '0');
        const memberId = `mbr_perf_${suffix}`;
        const membershipId = `msh_perf_${suffix}`;
        const invoiceId = `inv_perf_${suffix}`;
        const branchId = branches[index % branches.length];
        const joinedDaysAgo = 1 + (index % 720);
        const joinedAt = now - joinedDaysAgo * 86_400_000;
        const lastVisitAt = index % 10 === 0 ? null : now - (index % 120) * 86_400_000;
        const riskScore = index % 5 === 0 ? 72 : index % 3 === 0 ? 38 : 12;
        generatedMemberIds.push(memberId);

        insertClone('members', memberTemplate, {
          id: memberId,
          tenant_id: tenantId,
          user_id: null,
          home_branch_id: branchId,
          member_no: `PERF-${suffix}`,
          first_name: `Performance${suffix}`,
          last_name: 'Member',
          initials: 'PM',
          email: `performance.${suffix}@example.invalid`,
          email_normalized: `performance.${suffix}@example.invalid`,
          phone: null,
          phone_normalized: null,
          lifecycle: index % 20 === 0 ? 'grace' : 'active',
          tags: index % 7 === 0 ? '["high-volume"]' : '[]',
          risk_score: riskScore,
          risk_reasons: riskScore >= 55 ? '[{"code":"attendance_gap","label":"No recent visit"}]' : '[]',
          joined_on: isoDay(joinedAt),
          last_visit_at: lastVisitAt,
          version: 1,
          created_at: joinedAt,
          updated_at: now,
          deleted_at: null,
          merged_into_id: null,
        });

        const endsInDays = index % 5 === 0 ? 3 + (index % 10) : 30 + (index % 335);
        insertClone('memberships', membershipTemplate, {
          id: membershipId,
          tenant_id: tenantId,
          member_id: memberId,
          state: index % 20 === 0 ? 'grace' : 'active',
          started_on: isoDay(joinedAt),
          ends_on: isoDay(now + endsInDays * 86_400_000),
          auto_renew: index % 4 === 0 ? 0 : 1,
          previous_membership_id: null,
          version: 1,
          created_at: joinedAt,
          updated_at: now,
        });

        const totalMinor = 118_000 + (index % 8) * 59_000;
        const paid = index % 5 !== 0;
        insertClone('invoices', invoiceTemplate, {
          id: invoiceId,
          tenant_id: tenantId,
          branch_id: branchId,
          member_id: memberId,
          number: `PERF-2026-${suffix}`,
          state: paid ? 'paid' : 'open',
          issued_on: isoDay(joinedAt),
          due_on: isoDay(joinedAt + 7 * 86_400_000),
          currency: 'INR',
          subtotal_minor: totalMinor,
          discount_minor: 0,
          tax_minor: Math.round(totalMinor * 0.18),
          total_minor: totalMinor + Math.round(totalMinor * 0.18),
          paid_minor: paid ? totalMinor + Math.round(totalMinor * 0.18) : 0,
          refunded_minor: 0,
          voided: 0,
          void_reason: null,
          ref_type: 'membership',
          ref_id: membershipId,
          created_at: joinedAt,
          updated_at: now,
        });

        if (paid) {
          insertClone('payments', paymentTemplate, {
            id: `pay_perf_${suffix}`,
            tenant_id: tenantId,
            branch_id: branchId,
            invoice_id: invoiceId,
            member_id: memberId,
            method: ['upi', 'card', 'cash'][index % 3],
            state: 'succeeded',
            amount_minor: totalMinor + Math.round(totalMinor * 0.18),
            currency: 'INR',
            provider: 'performance_fixture',
            provider_ref: `perf_${suffix}`,
            idempotency_key: `performance-payment-${suffix}`,
            failure_reason: null,
            note: null,
            created_at: joinedAt,
            settled_at: joinedAt + 1_000,
          });
        }

        if (index % 3 !== 0 && sessions.length > 0) {
          while (sessionCursor < sessions.length) {
            const candidate = sessions[sessionCursor];
            const added = sessionAdds.get(candidate.id) ?? 0;
            if (candidate.booked + added < candidate.capacity) break;
            sessionCursor += 1;
          }
          if (sessionCursor < sessions.length) {
            const session = sessions[sessionCursor];
            const added = sessionAdds.get(session.id) ?? 0;
            insertClone('bookings', bookingTemplate, {
              id: `bkg_perf_${suffix}`,
              tenant_id: tenantId,
              session_id: session.id,
              member_id: memberId,
              state: session.starts_at < now ? 'attended' : 'confirmed',
              seat_no: session.booked + added + 1,
              booked_at: Math.min(now, session.starts_at - 86_400_000),
              cancelled_at: null,
              held_until: null,
              credits_used: 0,
              charge_minor: 0,
              came_from_waitlist: 0,
              idempotency_key: `performance-booking-${suffix}`,
              attended_at: session.starts_at < now ? session.ends_at : null,
            });
            sessionAdds.set(session.id, added + 1);
          }
        }

        if (index % 5 !== 0) {
          const enteredAt = now - (index % 180) * 86_400_000 - (index % 12) * 3_600_000;
          insertClone('check_ins', checkInTemplate, {
            id: `chk_perf_${suffix}`,
            tenant_id: tenantId,
            branch_id: branchId,
            member_id: memberId,
            method: index % 2 === 0 ? 'qr' : 'desk',
            decision: 'granted',
            entered_at: enteredAt,
            exited_at: enteredAt + 75 * 60_000,
            auto_closed: 0,
            override_by_id: null,
            override_by_name: null,
            override_reason: null,
            visit_number: 1 + (index % 150),
          });
        }

        if (index % 10 === 0) {
          const openedAt = now - (index % 60) * 86_400_000;
          insertClone('tickets', ticketTemplate, {
            id: `tkt_perf_${suffix}`,
            tenant_id: tenantId,
            branch_id: branchId,
            member_id: memberId,
            reference: `PERF-SUP-${suffix}`,
            category: index % 20 === 0 ? 'complaint' : 'general',
            subject: `Performance fixture ticket ${suffix}`,
            priority: index % 25 === 0 ? 'urgent' : 'normal',
            state: index % 30 === 0 ? 'resolved' : 'open',
            anonymous: 0,
            escalated: index % 25 === 0 ? 1 : 0,
            opened_at: openedAt,
            last_update_at: openedAt,
            closed_at: null,
            resolved_at: null,
            vulnerability_flag: 0,
          });
        }

        if (index % 20 === 0) {
          insertClone('stock_ledger', ledgerTemplate, {
            id: `stk_perf_${suffix}`,
            tenant_id: tenantId,
            branch_id: branchId,
            delta: index % 40 === 0 ? 10 : -1,
            reason: 'Performance fixture movement',
            ref_type: 'performance_fixture',
            ref_id: memberId,
            actor_name: 'Performance fixture',
            note: null,
            negative_override: 0,
            override_reason: null,
            at: joinedAt,
          });
        }
      }

      for (const session of sessions) {
        const added = sessionAdds.get(session.id) ?? 0;
        if (added > 0) database.prepare('update class_sessions set booked = booked + ? where id = ?').run(added, session.id);
      }
    })();

    database.exec('ANALYZE');
    database.pragma('wal_checkpoint(TRUNCATE)');
    const counts = Object.fromEntries(
      ['members', 'memberships', 'invoices', 'payments', 'bookings', 'check_ins', 'tickets', 'stock_ledger']
        .map((table) => [table, database.prepare(`select count(*) as count from ${table} where tenant_id = ?`).get(tenantId).count]),
    );
    return {
      tenantId,
      counts,
      memberId: generatedMemberIds[Math.floor(generatedMemberIds.length / 2)] ?? memberTemplate.id,
      automationId: database.prepare("select id from automations where tenant_id = ? and name = 'Renewal nudge' limit 1").get(tenantId)?.id
        ?? database.prepare('select id from automations where tenant_id = ? limit 1').get(tenantId).id,
    };
  } finally {
    database.close();
  }
}

async function percentileBenchmark(origin, cookie, name, path) {
  const samples = [];
  for (let attempt = 0; attempt < WARMUPS + SAMPLES; attempt += 1) {
    const started = performance.now();
    const response = await fetch(`${origin}${path}`, { headers: { cookie, origin } });
    const body = await response.text();
    const elapsed = performance.now() - started;
    if (!response.ok) throw new Error(`${name} returned ${response.status}: ${body.slice(0, 500)}`);
    if (attempt >= WARMUPS) samples.push(elapsed);
  }
  samples.sort((left, right) => left - right);
  const percentile = (value) => samples[Math.max(0, Math.ceil(value * samples.length) - 1)];
  return {
    samples: samples.length,
    p50Ms: Number(percentile(0.5).toFixed(2)),
    p95Ms: Number(percentile(0.95).toFixed(2)),
    minMs: Number(samples[0].toFixed(2)),
    maxMs: Number(samples.at(-1).toFixed(2)),
  };
}

async function measure(dataset) {
  const port = 8799;
  const origin = `http://127.0.0.1:${port}`;
  const invocation = pnpmInvocation(['-F', '@shark/api', 'start']);
  const child = spawn(invocation.command, invocation.args, {
    cwd: repository,
    env: {
      ...baseEnvironment,
      NODE_ENV: 'production',
      PORT: String(port),
      SHARK_DB: databasePath,
      SHARK_PUBLIC_ORIGIN: origin,
      SHARK_DISABLE_JOBS: 'true',
      SHARK_SERVE_STATIC: 'false',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let logs = '';
  child.stderr.on('data', (chunk) => { logs = `${logs}${String(chunk)}`.slice(-10_000); });
  try {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const ready = await fetch(`${origin}/ready`);
        if (ready.ok) break;
      } catch {
        // The process is still starting.
      }
      if (attempt === 59) throw new Error('Benchmark API did not become ready.');
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
    const signIn = await fetch(`${origin}/v1/auth/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ tenantSlug: 'shark', email: 'owner@sharkfitness.in', password: 'shark1234' }),
    });
    const session = signIn.headers.get('set-cookie')?.match(/shark_session=([^;,]+)/)?.[1];
    if (!signIn.ok || !session) throw new Error(`Benchmark sign-in failed with ${signIn.status}.`);
    const cookie = `shark_session=${session}`;
    const range = 'from=2026-05-01&to=2026-08-27';
    const routes = {
      dashboard: '/v1/admin/dashboard',
      memberDirectory: '/v1/admin/members?limit=50&offset=2400',
      memberDetail: `/v1/admin/members/${dataset.memberId}`,
      retention: `/v1/admin/reports/retention?${range}`,
      revenue: `/v1/admin/reports/revenue?${range}`,
      attendance: `/v1/admin/reports/attendance?${range}`,
      automationPlanning: `/v1/admin/automations/${dataset.automationId}/preview`,
    };
    const results = {};
    for (const [name, path] of Object.entries(routes)) {
      results[name] = await percentileBenchmark(origin, cookie, name, path);
    }
    return results;
  } catch (error) {
    throw new Error(`${String(error)}\nBenchmark API logs:\n${logs}`, { cause: error });
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolveExit) => child.once('exit', resolveExit)),
      new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

runPnpm(['-F', '@shark/api', 'migrate'], { SHARK_DB: databasePath, NODE_ENV: 'test' });
runPnpm(['-F', '@shark/api', 'seed'], { SHARK_DB: databasePath, NODE_ENV: 'test' });
const dataset = buildDataset();
const benchmarks = await measure(dataset);
const slowest = Object.entries(benchmarks).sort(([, left], [, right]) => right.p95Ms - left.p95Ms)[0];

console.log(JSON.stringify({
  measuredAt: new Date().toISOString(),
  runtime: { node: process.version, platform: `${process.platform}-${process.arch}`, samplesPerRoute: SAMPLES },
  artifactDirectory: root,
  databaseSizeBytes: statSync(databasePath).size,
  dataset: { targetMembers: TARGET_MEMBERS, ...dataset.counts },
  benchmarks,
  slowestRoute: { name: slowest[0], p95Ms: slowest[1].p95Ms },
}, null, 2));
