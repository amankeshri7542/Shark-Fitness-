import { and, eq, isNull } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db, schema, sqlite } from '../db/client.js';
import type { RequestContext } from '../lib/context.js';
import { id } from '../lib/ids.js';
import { daysBetween, HOUR, isoDate, localClockOnDay, MINUTE, nextLocalDayRange, now } from '../lib/time.js';
import {
  audienceFor,
  createAutomation,
  listAutomations,
  planRun,
  processDueDeliveries,
  runAutomation,
  runDueAutomations,
  runHistory,
  saveTemplate,
  updateAutomation,
} from '../services/automations.js';

const tenant = () => db.select().from(schema.tenants).where(eq(schema.tenants.slug, 'shark')).get()!;
const owner = (): RequestContext => {
  const user = db.select().from(schema.users).where(eq(schema.users.email, 'owner@sharkfitness.in')).get()!;
  return {
    requestId: id('req'),
    sessionId: 'test',
    authMethod: 'cookie',
    tenantId: tenant().id,
    userId: user.id,
    memberId: null,
    staffId: null,
    role: 'owner',
    name: user.name,
    branchIds: db.select({ id: schema.branches.id }).from(schema.branches).where(eq(schema.branches.tenantId, tenant().id)).all().map((row) => row.id),
    activeBranchId: null,
    permissions: ['automation.manage'],
    ip: '127.0.0.1',
    userAgent: 'test',
    impersonatorId: null,
  };
};

const NEVER_QUIET = { from: '00:00', to: '00:00' };

function automationRow(automationId: string) {
  return db.select().from(schema.automations).where(eq(schema.automations.id, automationId)).get()!;
}

function activeMember(branchId = 'br_kor') {
  return db
    .select({ member: schema.members, user: schema.users })
    .from(schema.members)
    .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
    .where(and(
      eq(schema.members.tenantId, tenant().id),
      eq(schema.members.homeBranchId, branchId),
      isNull(schema.members.deletedAt),
      isNull(schema.members.mergedIntoId),
      eq(schema.users.accountState, 'active'),
      isNull(schema.users.deletedAt),
    ))
    .get()!;
}

function createLive(channel: 'in_app' | 'sms', delayMin = 0): string {
  const ctx = owner();
  const code = `hardening.${channel}.${id('tpl')}`;
  db.insert(schema.messageTemplates)
    .values({
      id: id('tpl'),
      tenantId: ctx.tenantId,
      code,
      channel,
      version: 1,
      locale: 'en',
      subject: 'Reminder',
      body: 'Hi {{firstName}}, your membership ends on {{endsOn}}.',
      variables: ['firstName', 'endsOn'],
      updatedAt: now(),
    })
    .run();
  const created = createAutomation(ctx, {
    name: `Hardening ${channel} ${id('atm')}`,
    trigger: 'membership.expiring',
    description: 'Regression probe',
    conditions: [],
    channel,
    templateCode: code,
    delayMin,
    quietHours: NEVER_QUIET,
  });
  const automationId = created.automation.id;
  updateAutomation(ctx, automationId, { state: 'active' });
  updateAutomation(ctx, automationId, { dryRun: false });
  return automationId;
}

afterEach(() => {
  sqlite.exec('DROP TRIGGER IF EXISTS fail_automation_notification_probe');
});

describe('truthful automation delivery', () => {
  it('suppresses an invited account during planning instead of promising a later send', () => {
    const automationId = createLive('in_app', 30);
    const automation = automationRow(automationId);
    const invited = db
      .select({ memberId: schema.members.id, userId: schema.users.id })
      .from(schema.memberships)
      .innerJoin(schema.members, eq(schema.members.id, schema.memberships.memberId))
      .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
      .where(and(
        eq(schema.memberships.tenantId, tenant().id),
        eq(schema.memberships.state, 'active'),
        eq(schema.users.accountState, 'active'),
        isNull(schema.members.deletedAt),
      ))
      .get()!;

    db.update(schema.users).set({ accountState: 'invited' }).where(eq(schema.users.id, invited.userId)).run();
    try {
      const planned = planRun(owner(), automation, now()).find((entry) => entry.subject.memberId === invited.memberId)!;

      expect(planned.decision).toMatchObject({ send: false, code: 'account_unavailable' });
    } finally {
      db.update(schema.users).set({ accountState: 'active' }).where(eq(schema.users.id, invited.userId)).run();
    }
  });

  it('suppresses an external channel when no provider exists and creates no pretend notification', () => {
    const automationId = createLive('sms');
    const before = db.select().from(schema.notifications).where(eq(schema.notifications.kind, 'automation')).all().length;

    const summary = runAutomation(owner(), automationId, now());

    expect(summary.considered).toBeGreaterThan(0);
    expect(summary.sent).toBe(0);
    expect(summary.queued).toBe(0);
    expect(summary.bySuppression.some((entry) => entry.code === 'provider_unavailable')).toBe(true);
    expect(db.select().from(schema.notifications).where(eq(schema.notifications.kind, 'automation')).all()).toHaveLength(before);
    expect(db.select().from(schema.automationDeliveries).where(eq(schema.automationDeliveries.automationId, automationId)).all()).toHaveLength(0);
  });

  it('re-checks account state after a delay instead of sending to a disabled user', () => {
    const automationId = createLive('in_app', 30);
    const atMs = now();
    runAutomation(owner(), automationId, atMs);
    const delivery = db.select().from(schema.automationDeliveries)
      .where(eq(schema.automationDeliveries.automationId, automationId)).get()!;

    db.update(schema.users).set({ accountState: 'disabled' }).where(eq(schema.users.id, delivery.userId)).run();
    try {
      processDueDeliveries(atMs + 30 * MINUTE, 1_000);
      const finished = db.select().from(schema.automationDeliveries).where(eq(schema.automationDeliveries.id, delivery.id)).get()!;
      expect(finished.state).toBe('suppressed');
      expect(finished.lastError).toMatch(/account is no longer active/i);
    } finally {
      db.update(schema.users).set({ accountState: 'active' }).where(eq(schema.users.id, delivery.userId)).run();
    }
  });

  it('reports an insert failure as failed rather than counting the plan as sent', () => {
    const automationId = createLive('in_app');
    sqlite.exec(`CREATE TRIGGER fail_automation_notification_probe
      BEFORE INSERT ON notifications WHEN NEW.kind = 'automation'
      BEGIN SELECT RAISE(ABORT, 'forced automation notification failure'); END`);

    const summary = runAutomation(owner(), automationId, now());

    expect(summary.failed).toBeGreaterThan(0);
    expect(summary.sent).toBe(0);
    const runs = db.select().from(schema.automationRuns).where(eq(schema.automationRuns.automationId, automationId)).all();
    expect(runs.filter((run) => run.outcome === 'failed')).toHaveLength(summary.failed);
    expect(runs.some((run) => run.reason.includes('Retry'))).toBe(true);
  });

  it('propagates failed scheduler deliveries so the enclosing job cannot claim success', () => {
    createLive('in_app');
    sqlite.exec(`CREATE TRIGGER fail_automation_notification_probe
      BEFORE INSERT ON notifications WHEN NEW.kind = 'automation'
      BEGIN SELECT RAISE(ABORT, 'forced scheduled notification failure'); END`);

    expect(() => runDueAutomations(now())).toThrow(/automation run.*failed/i);
  });

  it('persists a delayed event, survives another run, and sends only when due', () => {
    const automationId = createLive('in_app', 30);
    const atMs = now();

    const first = runAutomation(owner(), automationId, atMs);
    const duplicate = runAutomation(owner(), automationId, atMs);
    const deliveries = db.select().from(schema.automationDeliveries).where(eq(schema.automationDeliveries.automationId, automationId)).all();

    expect(first.queued).toBeGreaterThan(0);
    expect(first.sent).toBe(0);
    expect(duplicate.sent).toBe(0);
    expect(duplicate.bySuppression.some((entry) => entry.code === 'already_sent')).toBe(true);
    expect(deliveries).toHaveLength(first.queued);
    expect(deliveries.every((delivery) => delivery.state === 'queued' && delivery.dueAt === atMs + 30 * 60_000)).toBe(true);
    // The worker is global and may legitimately process another retry left by
    // a preceding test. Assert this automation's rows, not the global count.
    processDueDeliveries(atMs + 29 * 60_000, 1_000);
    expect(
      db.select().from(schema.automationDeliveries).where(eq(schema.automationDeliveries.automationId, automationId)).all()
        .every((delivery) => delivery.state === 'queued'),
    ).toBe(true);

    processDueDeliveries(atMs + 30 * 60_000, 1_000);
    expect(
      db.select().from(schema.automationDeliveries).where(eq(schema.automationDeliveries.automationId, automationId)).all()
        .every((delivery) => delivery.state === 'sent' && delivery.attempts === 1),
    ).toBe(true);
  });

  it('durably holds a late-night welcome until quiet hours end on the next local day', () => {
    const ctx = owner();
    const { member } = activeMember();
    const originalJoinedOn = member.joinedOn;
    const atMs = Date.parse('2030-01-01T18:00:00Z'); // 23:30 Asia/Kolkata
    const code = `quiet.welcome.${id('tpl')}`;
    db.insert(schema.messageTemplates).values({
      id: id('tpl'), tenantId: ctx.tenantId, code, channel: 'in_app', version: 1, locale: 'en', subject: null,
      body: 'Welcome {{firstName}}', variables: ['firstName'], updatedAt: atMs,
    }).run();
    db.update(schema.members).set({ joinedOn: '2030-01-01' }).where(eq(schema.members.id, member.id)).run();

    try {
      const created = createAutomation(ctx, {
        name: `Quiet welcome ${id('atm')}`, trigger: 'member.joined', conditions: [], channel: 'in_app',
        templateCode: code, delayMin: 0, branchIds: [member.homeBranchId], quietHours: { from: '21:00', to: '08:00' },
      }).automation;
      updateAutomation(ctx, created.id, { state: 'active' });
      updateAutomation(ctx, created.id, { dryRun: false });

      const summary = runAutomation(ctx, created.id, atMs);
      const delivery = db.select().from(schema.automationDeliveries)
        .where(and(eq(schema.automationDeliveries.automationId, created.id), eq(schema.automationDeliveries.memberId, member.id)))
        .get()!;

      expect(summary.queued).toBeGreaterThan(0);
      expect(delivery.state).toBe('queued');
      expect(delivery.dueAt).toBe(Date.parse('2030-01-02T02:30:00Z')); // 08:00 Asia/Kolkata
      // A stale due time or a policy change can make the worker encounter the
      // row while the branch is still quiet. It must persist the exact next
      // local end, not poll hourly or spend a retry.
      db.update(schema.automationDeliveries).set({ dueAt: atMs }).where(eq(schema.automationDeliveries.id, delivery.id)).run();
      processDueDeliveries(atMs, 1_000);
      const held = db.select().from(schema.automationDeliveries).where(eq(schema.automationDeliveries.id, delivery.id)).get()!;
      expect(held.dueAt).toBe(Date.parse('2030-01-02T02:30:00Z'));
      expect(held.attempts).toBe(0);

      processDueDeliveries(held.dueAt, 1_000);
      expect(db.select().from(schema.automationDeliveries).where(eq(schema.automationDeliveries.id, delivery.id)).get()!.state).toBe('sent');
    } finally {
      db.update(schema.members).set({ joinedOn: originalJoinedOn }).where(eq(schema.members.id, member.id)).run();
    }
  });

  it('retries a post-claim validation error instead of stranding the delivery in processing', () => {
    const automationId = createLive('in_app', 30);
    const atMs = now();
    runAutomation(owner(), automationId, atMs);
    const delivery = db.select().from(schema.automationDeliveries)
      .where(eq(schema.automationDeliveries.automationId, automationId)).get()!;
    const branch = db.select().from(schema.branches).where(eq(schema.branches.id, delivery.branchId)).get()!;

    db.update(schema.branches).set({ timezone: 'Mars/Olympus' }).where(eq(schema.branches.id, branch.id)).run();
    try {
      expect(() => processDueDeliveries(atMs + 30 * MINUTE, 1_000)).not.toThrow();
      const retried = db.select().from(schema.automationDeliveries).where(eq(schema.automationDeliveries.id, delivery.id)).get()!;
      expect(retried.state).toBe('queued');
      expect(retried.attempts).toBe(1);
      expect(retried.lastError).toMatch(/time zone/i);
    } finally {
      db.update(schema.branches).set({ timezone: branch.timezone }).where(eq(schema.branches.id, branch.id)).run();
    }
  });
});

describe('branch-scoped automation authority', () => {
  it('stores a regional operator’s ceiling and never widens it in preview/list', () => {
    const ctx = { ...owner(), role: 'regional_manager' as const, branchIds: ['br_kor'] };
    const code = `scope.${id('tpl')}`;
    db.insert(schema.messageTemplates).values({
      id: id('tpl'), tenantId: ctx.tenantId, code, channel: 'in_app', version: 1, locale: 'en', subject: null,
      body: 'Hi {{firstName}}', variables: ['firstName'], updatedAt: now(),
    }).run();

    const created = createAutomation(ctx, {
      name: `Scoped ${id('atm')}`, trigger: 'membership.expiring', conditions: [], channel: 'in_app',
      templateCode: code, delayMin: 0, quietHours: NEVER_QUIET,
    }).automation;
    const stored = db.select().from(schema.automations).where(eq(schema.automations.id, created.id)).get()!;

    expect(stored.branchIds).toEqual(['br_kor']);
    expect(listAutomations(ctx).items.some((row) => row.id === created.id)).toBe(true);
    expect(audienceFor(ctx.tenantId, stored.trigger, now(), stored.branchIds ?? undefined).every((subject) => subject.branchId === 'br_kor')).toBe(true);
  });

  it('previews a stored global rule across its full scope even when one branch is selected', () => {
    const automationId = createLive('in_app', 0);
    const automation = automationRow(automationId);
    expect(automation.branchIds).toBeNull();

    const allBranches = new Set(planRun(owner(), automation, now()).map((entry) => entry.subject.branchId));
    const selected = { ...owner(), activeBranchId: 'br_kor' };
    const selectedBranches = new Set(planRun(selected, automation, now()).map((entry) => entry.subject.branchId));

    expect(allBranches.size).toBeGreaterThan(1);
    expect(selectedBranches).toEqual(allBranches);
  });
});

describe('immutable template pins', () => {
  it('does not silently adopt a newer template on a state-only patch', () => {
    const ctx = owner();
    const code = `pin.${id('tpl')}`;
    const first = saveTemplate(ctx, { code, channel: 'in_app', subject: null, body: 'Version one {{firstName}}' }).template;
    const created = createAutomation(ctx, {
      name: `Pinned ${id('atm')}`, trigger: 'membership.expiring', conditions: [], channel: 'in_app',
      templateCode: code, delayMin: 0, quietHours: NEVER_QUIET,
    }).automation;
    saveTemplate(ctx, { code, channel: 'in_app', subject: null, body: 'Version two {{firstName}}' });

    updateAutomation(ctx, created.id, { state: 'active' });
    updateAutomation(ctx, created.id, { dryRun: false });
    const stored = automationRow(created.id);

    expect(stored.actions[0]).toMatchObject({ templateId: first.id, templateVersion: first.version });
    expect(planRun(ctx, stored, now()).find((entry) => entry.preview)?.preview).toContain('Version one');
  });
});

describe('delayed resource validity', () => {
  it('suppresses a queued delivery when its member is deleted before delivery', () => {
    const automationId = createLive('in_app', 30);
    const atMs = now();
    runAutomation(owner(), automationId, atMs);
    const delivery = db.select().from(schema.automationDeliveries)
      .where(eq(schema.automationDeliveries.automationId, automationId)).get()!;

    db.update(schema.members).set({ deletedAt: atMs + 1 }).where(eq(schema.members.id, delivery.memberId)).run();
    try {
      processDueDeliveries(atMs + 30 * MINUTE, 1_000);
      const finished = db.select().from(schema.automationDeliveries).where(eq(schema.automationDeliveries.id, delivery.id)).get()!;
      expect(finished.state).toBe('suppressed');
      expect(finished.lastError).toMatch(/member record/i);
    } finally {
      db.update(schema.members).set({ deletedAt: null }).where(eq(schema.members.id, delivery.memberId)).run();
    }
  });

  it('suppresses a class reminder when the booking is cancelled during the delay', () => {
    const ctx = owner();
    const { member } = activeMember();
    const atMs = Date.parse('2031-03-08T17:00:00Z');
    const range = nextLocalDayRange(atMs, 'Asia/Kolkata');
    const classType = db.select().from(schema.classTypes).where(eq(schema.classTypes.tenantId, ctx.tenantId)).get()!;
    const sessionId = id('ses');
    const bookingId = id('bkg');
    const code = `class.delay.${id('tpl')}`;
    db.insert(schema.classSessions).values({
      id: sessionId, tenantId: ctx.tenantId, branchId: member.homeBranchId, classTypeId: classType.id, roomId: null,
      trainerId: null, seriesId: null, startsAt: range.from + 10 * HOUR, endsAt: range.from + 11 * HOUR,
      capacity: 10, booked: 1, state: 'scheduled', bookingOpensAt: null, cancelDeadlineAt: null,
      creditsRequired: 0, dropInPriceMinor: null, lateCancelFeeMinor: 0, waitlistEnabled: true,
      cancelledReason: null, substituteFor: null, notes: null, version: 1, createdAt: atMs, updatedAt: atMs,
    }).run();
    db.insert(schema.bookings).values({
      id: bookingId, tenantId: ctx.tenantId, sessionId, memberId: member.id, state: 'confirmed', seatNo: null,
      heldUntil: null, bookedAt: atMs, cancelledAt: null, creditsUsed: 0, chargeMinor: 0,
      cameFromWaitlist: false, idempotencyKey: bookingId, attendedAt: null,
    }).run();
    db.insert(schema.messageTemplates).values({
      id: id('tpl'), tenantId: ctx.tenantId, code, channel: 'in_app', version: 1, locale: 'en', subject: null,
      body: 'Hi {{firstName}}, {{className}} is tomorrow.', variables: ['firstName', 'className'], updatedAt: atMs,
    }).run();
    const created = createAutomation(ctx, {
      name: `Class delayed ${id('atm')}`, trigger: 'class.tomorrow', conditions: [], channel: 'in_app',
      templateCode: code, delayMin: 30, branchIds: [member.homeBranchId], quietHours: NEVER_QUIET,
    }).automation;
    updateAutomation(ctx, created.id, { state: 'active' });
    updateAutomation(ctx, created.id, { dryRun: false });
    runAutomation(ctx, created.id, atMs);
    const delivery = db.select().from(schema.automationDeliveries)
      .where(and(eq(schema.automationDeliveries.automationId, created.id), eq(schema.automationDeliveries.memberId, member.id)))
      .get()!;

    db.update(schema.bookings).set({ state: 'cancelled', cancelledAt: atMs + MINUTE }).where(eq(schema.bookings.id, bookingId)).run();
    processDueDeliveries(atMs + 30 * MINUTE, 1_000);

    const finished = db.select().from(schema.automationDeliveries).where(eq(schema.automationDeliveries.id, delivery.id)).get()!;
    expect(finished.state).toBe('suppressed');
    expect(finished.lastError).toMatch(/no longer applies/i);
  });

  it('reports the actual delayed attempt time separately from the enqueue time', () => {
    const automationId = createLive('in_app', 30);
    const atMs = now();
    runAutomation(owner(), automationId, atMs);
    processDueDeliveries(atMs + 30 * MINUTE, 1_000);

    const row = runHistory(owner(), { automationId, limit: 1 }).items[0]!;
    expect(row.at).toBe(new Date(atMs).toISOString());
    expect(row.lastAttemptAt).toBe(new Date(atMs + 30 * MINUTE).toISOString());
  });
});

describe('payment-failure branch ownership', () => {
  it('attributes a cross-branch failure to the payment branch rather than the member home branch', () => {
    const ctx = owner();
    const { member } = activeMember('br_kor');
    const invoiceId = id('inv');
    const paymentId = id('pay');
    const atMs = now();
    db.insert(schema.invoices).values({
      id: invoiceId, tenantId: ctx.tenantId, branchId: 'br_hsr', memberId: member.id, number: `INV-${invoiceId}`,
      state: 'open', issuedOn: isoDate(atMs, 'Asia/Kolkata'), dueOn: isoDate(atMs, 'Asia/Kolkata'),
      subtotalMinor: 1000, discountMinor: 0, taxMinor: 0, totalMinor: 1000, paidMinor: 0, refundedMinor: 0,
      voided: false, createdAt: atMs, updatedAt: atMs,
    }).run();
    db.insert(schema.payments).values({
      id: paymentId, tenantId: ctx.tenantId, branchId: 'br_hsr', invoiceId, memberId: member.id,
      method: 'card', state: 'failed', amountMinor: 1000, idempotencyKey: paymentId, createdAt: atMs,
    }).run();

    const inPaymentBranch = audienceFor(ctx.tenantId, 'membership.payment_failed', atMs, ['br_hsr'])
      .find((entry) => entry.occurrenceId === paymentId);
    const inHomeBranch = audienceFor(ctx.tenantId, 'membership.payment_failed', atMs, ['br_kor'])
      .find((entry) => entry.occurrenceId === paymentId);

    expect(inPaymentBranch?.branchId).toBe('br_hsr');
    expect(inHomeBranch).toBeUndefined();
  });

  it('suppresses a delayed notice when the payment is no longer failed', () => {
    const ctx = owner();
    const { member } = activeMember('br_kor');
    const invoiceId = id('inv');
    const paymentId = id('pay');
    const atMs = now();
    db.insert(schema.invoices).values({
      id: invoiceId, tenantId: ctx.tenantId, branchId: 'br_kor', memberId: member.id, number: `INV-${invoiceId}`,
      state: 'open', issuedOn: isoDate(atMs, 'Asia/Kolkata'), dueOn: isoDate(atMs, 'Asia/Kolkata'),
      subtotalMinor: 1000, discountMinor: 0, taxMinor: 0, totalMinor: 1000, paidMinor: 0, refundedMinor: 0,
      voided: false, createdAt: atMs, updatedAt: atMs,
    }).run();
    db.insert(schema.payments).values({
      id: paymentId, tenantId: ctx.tenantId, branchId: 'br_kor', invoiceId, memberId: member.id,
      method: 'card', state: 'failed', amountMinor: 1000, idempotencyKey: paymentId, createdAt: atMs,
    }).run();
    const code = `payment.delay.${id('tpl')}`;
    db.insert(schema.messageTemplates).values({
      id: id('tpl'), tenantId: ctx.tenantId, code, channel: 'in_app', version: 1, locale: 'en', subject: null,
      body: 'Payment {{invoiceNumber}} failed.', variables: ['invoiceNumber'], updatedAt: atMs,
    }).run();
    const created = createAutomation(ctx, {
      name: `Payment delayed ${id('atm')}`, trigger: 'membership.payment_failed', conditions: [], channel: 'in_app',
      templateCode: code, delayMin: 30, branchIds: ['br_kor'], quietHours: NEVER_QUIET,
    }).automation;
    updateAutomation(ctx, created.id, { state: 'active' });
    updateAutomation(ctx, created.id, { dryRun: false });
    runAutomation(ctx, created.id, atMs);
    const delivery = db.select().from(schema.automationDeliveries)
      .where(and(eq(schema.automationDeliveries.automationId, created.id), eq(schema.automationDeliveries.eventKey, `membership.payment_failed:${member.id}:${paymentId}`)))
      .get()!;

    db.update(schema.payments).set({ state: 'succeeded' }).where(eq(schema.payments.id, paymentId)).run();
    processDueDeliveries(atMs + 30 * MINUTE, 1_000);

    const finished = db.select().from(schema.automationDeliveries).where(eq(schema.automationDeliveries.id, delivery.id)).get()!;
    expect(finished.state).toBe('suppressed');
    expect(finished.lastError).toMatch(/no longer applies/i);
  });
});

describe('local-calendar time semantics', () => {
  it('rejects clock-shaped but impossible quiet-hours values before a rule can run', () => {
    const automationId = createLive('in_app');
    expect(() => updateAutomation(owner(), automationId, { quietHours: { from: '24:00', to: '08:00' } }))
      .toThrow(/real 24-hour time/i);
  });

  it.each([
    ['Asia/Kolkata', '2026-08-23T18:00:00Z', '2026-08-24'], // 23:30 local
    ['Asia/Kolkata', '2026-08-23T19:00:00Z', '2026-08-25'], // 00:30 local
    ['Asia/Dubai', '2026-08-23T19:30:00Z', '2026-08-24'],
    ['Asia/Dubai', '2026-08-23T20:30:00Z', '2026-08-25'],
    ['America/New_York', '2026-08-24T03:30:00Z', '2026-08-24'],
    ['America/New_York', '2026-08-24T04:30:00Z', '2026-08-25'],
    ['Asia/Kolkata', '2026-12-31T18:00:00Z', '2027-01-01'],
  ])('counts the next local date as one day in %s at %s', (timeZone, instant, endsOn) => {
    expect(daysBetween(isoDate(Date.parse(instant), timeZone), endsOn)).toBe(1);
  });

  it('uses the next New York calendar day across the spring DST transition', () => {
    const range = nextLocalDayRange(Date.parse('2026-03-07T17:00:00Z'), 'America/New_York');
    expect(range.day).toBe('2026-03-08');
    expect(range.to - range.from).toBe(23 * HOUR);
  });

  it('uses the next New York calendar day across the autumn DST transition', () => {
    const range = nextLocalDayRange(Date.parse('2026-10-31T16:00:00Z'), 'America/New_York');
    expect(range.day).toBe('2026-11-01');
    expect(range.to - range.from).toBe(25 * HOUR);
  });

  it('resolves a skipped New York quiet-hours end to the first real minute after the spring gap', () => {
    expect(localClockOnDay('2026-03-08', '02:30', 'America/New_York')).toBe(Date.parse('2026-03-08T07:00:00Z'));
  });

  it('resolves an ambiguous New York wall clock to the first occurrence during the autumn fold', () => {
    expect(localClockOnDay('2026-11-01', '01:30', 'America/New_York')).toBe(Date.parse('2026-11-01T05:30:00Z'));
  });

  it('holds through the second occurrence of a folded New York quiet-hour minute', () => {
    const ctx = owner();
    const { member } = activeMember();
    const branch = db.select().from(schema.branches).where(eq(schema.branches.id, member.homeBranchId)).get()!;
    const atMs = Date.parse('2026-11-01T06:15:00Z'); // second 01:15 after the fallback
    const code = `fold.quiet.${id('tpl')}`;
    db.insert(schema.messageTemplates).values({
      id: id('tpl'), tenantId: ctx.tenantId, code, channel: 'in_app', version: 1, locale: 'en', subject: null,
      body: 'Welcome {{firstName}}', variables: ['firstName'], updatedAt: atMs,
    }).run();
    db.update(schema.branches).set({ timezone: 'America/New_York' }).where(eq(schema.branches.id, branch.id)).run();
    db.update(schema.members).set({ joinedOn: '2026-11-01' }).where(eq(schema.members.id, member.id)).run();

    try {
      const created = createAutomation(ctx, {
        name: `Fold quiet ${id('atm')}`, trigger: 'member.joined', conditions: [], channel: 'in_app',
        templateCode: code, delayMin: 0, branchIds: [branch.id], quietHours: { from: '00:00', to: '01:30' },
      }).automation;
      updateAutomation(ctx, created.id, { state: 'active' });
      updateAutomation(ctx, created.id, { dryRun: false });
      runAutomation(ctx, created.id, atMs);

      const delivery = db.select().from(schema.automationDeliveries)
        .where(and(eq(schema.automationDeliveries.automationId, created.id), eq(schema.automationDeliveries.memberId, member.id)))
        .get()!;
      expect(delivery.dueAt).toBe(Date.parse('2026-11-01T06:30:00Z'));
    } finally {
      db.update(schema.branches).set({ timezone: branch.timezone }).where(eq(schema.branches.id, branch.id)).run();
      db.update(schema.members).set({ joinedOn: member.joinedOn }).where(eq(schema.members.id, member.id)).run();
    }
  });

  it('attributes a cross-branch class to the session branch and its tomorrow window', () => {
    const atMs = Date.parse('2026-03-07T17:00:00Z');
    const member = db.select().from(schema.members).where(eq(schema.members.homeBranchId, 'br_kor')).limit(1).get()!;
    const classType = db.select().from(schema.classTypes).where(eq(schema.classTypes.tenantId, member.tenantId)).limit(1).get()!;
    const sessionId = id('ses');
    const bookingId = id('bkg');
    const original = db.select().from(schema.branches).where(eq(schema.branches.id, 'br_hsr')).get()!;

    sqlite.exec('BEGIN');
    try {
      db.update(schema.branches).set({ timezone: 'America/New_York' }).where(eq(schema.branches.id, 'br_hsr')).run();
      const tomorrow = nextLocalDayRange(atMs, 'America/New_York');
      db.insert(schema.classSessions).values({
        id: sessionId, tenantId: member.tenantId, branchId: 'br_hsr', classTypeId: classType.id, roomId: null,
        trainerId: null, seriesId: null, startsAt: tomorrow.from + 10 * HOUR, endsAt: tomorrow.from + 11 * HOUR,
        capacity: 20, booked: 1, state: 'scheduled', bookingOpensAt: null, cancelDeadlineAt: null,
        creditsRequired: 0, dropInPriceMinor: null, lateCancelFeeMinor: 0, waitlistEnabled: true,
        cancelledReason: null, substituteFor: null, notes: null, version: 1, createdAt: atMs, updatedAt: atMs,
      }).run();
      db.insert(schema.bookings).values({
        id: bookingId, tenantId: member.tenantId, sessionId, memberId: member.id, state: 'confirmed',
        seatNo: null, heldUntil: null, bookedAt: atMs, cancelledAt: null, creditsUsed: 0,
        chargeMinor: 0, cameFromWaitlist: false, idempotencyKey: bookingId, attendedAt: null,
      }).run();

      const audience = audienceFor(member.tenantId, 'class.tomorrow', atMs, ['br_hsr']);
      const subject = audience.find((entry) => entry.occurrenceId === sessionId)!;
      expect(subject.branchId).toBe('br_hsr');
      expect(subject.branchTimezone).toBe('America/New_York');
      expect(subject.variables.branchName).toBe(original.name);
    } finally {
      sqlite.exec('ROLLBACK');
    }
  });
});
