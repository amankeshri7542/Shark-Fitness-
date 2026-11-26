import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { MINUTE, now } from '../lib/time.js';
import { testTotp } from './helpers/mfa.js';
import { call, signIn, userIdFor, type TestSession } from './helpers/session.js';

/* ============================================================================
   Broadcasts (P07 AC6; PF-COMM-006).
   ========================================================================= */

let owner: TestSession;
let manager: TestSession;
const created: string[] = [];

interface ChannelPreview {
  channel: string;
  recipients: number;
  heldForQuietHours: number;
  excluded: Record<string, number>;
  ratePerMessageMinor: number;
  estimatedCostMinor: number;
}
interface Preview {
  segmentSize: number;
  chosen: ChannelPreview;
  byChannel: ChannelPreview[];
  approvalRequired: boolean;
}

const base = {
  name: 'P07 test broadcast',
  purpose: 'operational' as const,
  segment: { statuses: ['active'], branchIds: ['br_kor'] },
  title: 'Holiday hours',
  body: 'Hi {{firstName}}, Koramangala opens at 8am on Monday.',
};

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function create(session: TestSession, channel: string, extra: Record<string, unknown> = {}) {
  const response = await call(session, 'POST', '/v1/admin/broadcasts', { ...base, channel, ...extra });
  expect(response.status).toBe(201);
  const body = await json<{ broadcast: { id: string; recipientCount: number; approvalRequired: boolean }; preview: Preview }>(response);
  created.push(body.broadcast.id);
  return body;
}

function deliveries(broadcastId: string) {
  return db
    .select()
    .from(schema.notificationDeliveries)
    .where(and(eq(schema.notificationDeliveries.source, 'broadcast'), eq(schema.notificationDeliveries.sourceId, broadcastId)))
    .all();
}

async function setEngagement(body: Record<string, unknown>) {
  expect((await call(owner, 'PATCH', '/v1/admin/settings/engagement', body)).status).toBe(200);
}

beforeAll(async () => {
  [owner, manager] = await Promise.all([signIn('owner@sharkfitness.in', 'shark', true), signIn('manager@sharkfitness.in')]);
  await setEngagement({ broadcastApprovalThreshold: 100_000 });
});

afterAll(async () => {
  if (created.length) {
    db.delete(schema.notifications).where(inArray(schema.notifications.id, db.select({ id: schema.notificationDeliveries.notificationId }).from(schema.notificationDeliveries).where(inArray(schema.notificationDeliveries.sourceId, created)).all().map((r) => r.id ?? ''))).run();
    db.delete(schema.notificationDeliveries).where(inArray(schema.notificationDeliveries.sourceId, created)).run();
    db.delete(schema.broadcasts).where(inArray(schema.broadcasts.id, created)).run();
  }
  const tenant = db.select().from(schema.tenants).where(eq(schema.tenants.id, 'ten_shark')).get()!;
  const policy = { ...(tenant.policy as Record<string, unknown>) };
  delete policy.broadcastApprovalThreshold;
  delete policy.messageRates;
  db.update(schema.tenants).set({ policy: policy as never }).where(eq(schema.tenants.id, 'ten_shark')).run();
});

describe('preview', () => {
  it('counts exactly the recipients a send then reaches, after every exclusion', async () => {
    const { broadcast, preview } = await create(manager, 'sms', { purpose: 'promotional' });
    expect(preview.segmentSize).toBeGreaterThan(0);
    const excluded = Object.values(preview.chosen.excluded).reduce((a, b) => a + b, 0);
    expect(preview.chosen.recipients + excluded).toBe(preview.segmentSize);
    // Seeded consent: some members said no to SMS offers.
    expect((preview.chosen.excluded.no_consent ?? 0) + (preview.chosen.excluded.opted_out ?? 0)).toBeGreaterThan(0);

    const sent = await json<{ recipients: number; suppressed: number }>(await call(manager, 'POST', `/v1/admin/broadcasts/${broadcast.id}/send`));
    expect(sent.recipients).toBe(preview.chosen.recipients);
    expect(sent.suppressed).toBe(excluded);

    const rows = deliveries(broadcast.id);
    expect(rows.filter((r) => r.state !== 'suppressed' && r.state !== 'failed')).toHaveLength(preview.chosen.recipients);
    expect(rows.filter((r) => r.state === 'suppressed')).toHaveLength(excluded);
    expect(rows.every((r) => r.purpose === 'promotional')).toBe(true);

    const report = await json<{ report: { counts: { total: number; suppressed: number } } }>(await call(manager, 'GET', `/v1/admin/broadcasts/${broadcast.id}`));
    expect(report.report.counts.total).toBe(preview.segmentSize);
    expect(report.report.counts.suppressed).toBe(excluded);
  });

  it('estimates cost as recipients × the gym’s rate for each channel', async () => {
    await setEngagement({ messageRates: { sms: 30, whatsapp: 75, email: 12 } });
    const preview = await json<Preview>(await call(manager, 'POST', '/v1/admin/broadcasts/preview', { ...base, channel: 'sms', purpose: 'promotional' }));
    const rates: Record<string, number> = { in_app: 0, push: 0, email: 12, sms: 30, whatsapp: 75 };
    for (const c of preview.byChannel) {
      expect(c.ratePerMessageMinor).toBe(rates[c.channel]);
      expect(c.estimatedCostMinor).toBe(c.recipients * rates[c.channel]!);
    }
    expect(preview.chosen.estimatedCostMinor).toBe(preview.chosen.recipients * 30);
    // Push is not set up on this server: everyone is excluded, and it says why.
    const push = preview.byChannel.find((c) => c.channel === 'push')!;
    expect(push.recipients).toBe(0);
    expect(push.excluded.channel_unavailable).toBe(preview.segmentSize);
  });
});

describe('dry run', () => {
  it('records what would happen and sends nothing', async () => {
    const { broadcast, preview } = await create(manager, 'in_app');
    const notesBefore = db.select().from(schema.notifications).all().length;
    const dry = await json<{ dryRun: boolean; preview: Preview }>(await call(manager, 'POST', `/v1/admin/broadcasts/${broadcast.id}/dry-run`));
    expect(dry.dryRun).toBe(true);
    expect(dry.preview.chosen.recipients).toBe(preview.chosen.recipients);
    expect(deliveries(broadcast.id)).toHaveLength(0);
    expect(db.select().from(schema.notifications).all().length).toBe(notesBefore);
    const row = db.select().from(schema.broadcasts).where(eq(schema.broadcasts.id, broadcast.id)).get()!;
    expect(row.lastDryRunAt).not.toBeNull();
    expect(row.state).toBe('draft');
  });
});

describe('owner approval above the threshold', () => {
  it('holds the send until an owner approves with a fresh re-authentication', async () => {
    await setEngagement({ broadcastApprovalThreshold: 2 });
    const { broadcast, preview } = await create(manager, 'in_app');
    expect(preview.chosen.recipients).toBeGreaterThan(2);
    expect(preview.approvalRequired).toBe(true);

    const held = await call(manager, 'POST', `/v1/admin/broadcasts/${broadcast.id}/send`);
    expect(held.status).toBe(412);
    expect((await json<{ error: { message: string } }>(held)).error.message).toMatch(/waiting for an owner to approve it/);
    expect(db.select().from(schema.broadcasts).where(eq(schema.broadcasts.id, broadcast.id)).get()!.state).toBe('awaiting_approval');
    expect(deliveries(broadcast.id)).toHaveLength(0);

    // A manager cannot approve.
    expect((await call(manager, 'POST', `/v1/admin/broadcasts/${broadcast.id}/approve`)).status).toBe(403);

    // An owner whose last sign-in was a while ago must re-authenticate first.
    const ownerId = userIdFor('owner@sharkfitness.in');
    db.update(schema.sessions).set({ reauthenticatedAt: now() - 10 * MINUTE }).where(eq(schema.sessions.userId, ownerId)).run();
    const stale = await call(owner, 'POST', `/v1/admin/broadcasts/${broadcast.id}/approve`);
    expect(stale.status).toBe(401);
    expect((await json<{ error: { code: string } }>(stale)).error.code).toBe('STEP_UP_REQUIRED');

    expect((await call(owner, 'POST', '/v1/auth/step-up', { password: 'shark1234', code: testTotp(ownerId) })).status).toBe(200);
    expect((await call(owner, 'POST', `/v1/admin/broadcasts/${broadcast.id}/approve`)).status).toBe(200);

    const sent = await call(manager, 'POST', `/v1/admin/broadcasts/${broadcast.id}/send`);
    expect(sent.status).toBe(200);
    expect((await json<{ recipients: number }>(sent)).recipients).toBe(preview.chosen.recipients);
    expect(deliveries(broadcast.id).filter((d) => d.state === 'sent')).toHaveLength(preview.chosen.recipients);
    await setEngagement({ broadcastApprovalThreshold: 100_000 });
  });

  it('keeps "awaiting approval" when the console sends with an idempotency key, and re-holds a send that outgrew its approval', async () => {
    await setEngagement({ broadcastApprovalThreshold: 2 });
    try {
      const { broadcast, preview } = await create(manager, 'in_app');
      const held = await call(manager, 'POST', `/v1/admin/broadcasts/${broadcast.id}/send`, undefined, { 'idempotency-key': `idem-${broadcast.id}-1` });
      expect(held.status).toBe(412);
      const waiting = db.select().from(schema.broadcasts).where(eq(schema.broadcasts.id, broadcast.id)).get()!;
      expect(waiting.state).toBe('awaiting_approval');
      expect(waiting.approvalRequired).toBe(true);

      const ownerId = userIdFor('owner@sharkfitness.in');
      expect((await call(owner, 'POST', '/v1/auth/step-up', { password: 'shark1234', code: testTotp(ownerId) })).status).toBe(200);
      expect((await call(owner, 'POST', `/v1/admin/broadcasts/${broadcast.id}/approve`)).status).toBe(200);
      const approved = db.select().from(schema.broadcasts).where(eq(schema.broadcasts.id, broadcast.id)).get()!;
      expect(approved.recipientCount).toBe(preview.chosen.recipients);

      // The owner approved fewer people than the audience now holds (it grew
      // since): the approval does not stretch to cover them.
      db.update(schema.broadcasts).set({ recipientCount: preview.chosen.recipients - 1 }).where(eq(schema.broadcasts.id, broadcast.id)).run();
      const regrown = await call(manager, 'POST', `/v1/admin/broadcasts/${broadcast.id}/send`, undefined, { 'idempotency-key': `idem-${broadcast.id}-2` });
      expect(regrown.status).toBe(412);
      expect((await json<{ error: { message: string } }>(regrown)).error.message).toMatch(/more than the \d+ an owner approved/);
      const rehold = db.select().from(schema.broadcasts).where(eq(schema.broadcasts.id, broadcast.id)).get()!;
      expect(rehold.state).toBe('awaiting_approval');
      expect(rehold.approvedAt).toBeNull();
      expect(deliveries(broadcast.id)).toHaveLength(0);

      // Approved again for the audience as it is, the send goes.
      expect((await call(owner, 'POST', `/v1/admin/broadcasts/${broadcast.id}/approve`)).status).toBe(200);
      const sent = await call(manager, 'POST', `/v1/admin/broadcasts/${broadcast.id}/send`, undefined, { 'idempotency-key': `idem-${broadcast.id}-3` });
      expect(sent.status).toBe(200);
      expect(deliveries(broadcast.id)).toHaveLength(preview.chosen.recipients);
    } finally {
      await setEngagement({ broadcastApprovalThreshold: 100_000 });
    }
  });

  it('refuses a second send and keeps reception out', async () => {
    const { broadcast } = await create(manager, 'in_app');
    expect((await call(manager, 'POST', `/v1/admin/broadcasts/${broadcast.id}/send`)).status).toBe(200);
    expect((await call(manager, 'POST', `/v1/admin/broadcasts/${broadcast.id}/send`)).status).toBe(409);
    const reception = await signIn('reception@sharkfitness.in');
    expect((await call(reception, 'GET', '/v1/admin/broadcasts')).status).toBe(403);
    expect((await call(manager, 'POST', '/v1/admin/broadcasts', { ...base, channel: 'in_app', body: 'Your plan ends {{endsOn}}' })).status).toBe(422);
  });
});
