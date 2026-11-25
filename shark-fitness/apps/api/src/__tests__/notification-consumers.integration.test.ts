import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import type { RequestContext } from '../lib/context.js';
import { id } from '../lib/ids.js';
import { addDays, isoDate, localClockOnDay, now } from '../lib/time.js';
import { createAutomation, runAutomation, updateAutomation } from '../services/automations.js';
import { openDunning, runDueDunning } from '../services/dunning.js';
import { setNotificationDrivers, type ChannelDriver, type OutboundMessage } from '../services/notifications/drivers.js';
import { processNotificationQueue } from '../services/notifications/service.js';

/* ============================================================================
   Automations and dunning send through the NotificationService (P07 scope:
   "Consumers"). Off in-app, each attempt is a notification_deliveries row
   whose outcome says whether a provider delivered it or it was only logged.
   ========================================================================= */

const TENANT = 'ten_shark';

/** A provider stand-in that never touches the network. */
function recordingDriver(): ChannelDriver & { sent: OutboundMessage[] } {
  const sent: OutboundMessage[] = [];
  return {
    name: 'recording',
    delivers: true,
    available: true,
    sent,
    async send(message) {
      sent.push(message);
      return { outcome: 'sent', providerMessageId: `rec_${sent.length}` };
    },
  };
}

function middayIST(): number {
  const today = isoDate(now(), 'Asia/Kolkata');
  const candidate = localClockOnDay(today, '14:00', 'Asia/Kolkata');
  return candidate <= now() ? localClockOnDay(addDays(today, 1), '14:00', 'Asia/Kolkata') : candidate;
}

const ownerCtx = (): RequestContext => {
  const user = db.select().from(schema.users).where(and(eq(schema.users.tenantId, TENANT), eq(schema.users.role, 'owner'))).get()!;
  return {
    requestId: 'req_test',
    sessionId: 'ses_test',
    authMethod: 'cookie',
    tenantId: TENANT,
    userId: user.id,
    memberId: null,
    staffId: null,
    role: 'owner',
    name: user.name,
    branchIds: db.select({ id: schema.branches.id }).from(schema.branches).where(eq(schema.branches.tenantId, TENANT)).all().map((r) => r.id),
    activeBranchId: null,
    permissions: ['automation.manage'],
    ip: '127.0.0.1',
    userAgent: 'test',
    impersonatorId: null,
  };
};

const automationIds: string[] = [];
const invoiceIds: string[] = [];

afterEach(() => setNotificationDrivers(null));

afterAll(() => {
  if (automationIds.length) {
    db.delete(schema.notificationDeliveries).where(inArray(schema.notificationDeliveries.sourceId, automationIds)).run();
    db.delete(schema.automationRuns).where(inArray(schema.automationRuns.automationId, automationIds)).run();
    db.delete(schema.automationDeliveries).where(inArray(schema.automationDeliveries.automationId, automationIds)).run();
    db.delete(schema.automations).where(inArray(schema.automations.id, automationIds)).run();
  }
  if (invoiceIds.length) {
    db.delete(schema.notificationDeliveries).where(inArray(schema.notificationDeliveries.sourceId, invoiceIds)).run();
    db.delete(schema.dunningAttempts).where(inArray(schema.dunningAttempts.invoiceId, invoiceIds)).run();
    db.delete(schema.invoices).where(inArray(schema.invoices.id, invoiceIds)).run();
  }
});

describe('automations through the NotificationService', () => {
  it('hands an email automation to the service once a real driver is configured', async () => {
    const driver = recordingDriver();
    setNotificationDrivers({ email: driver });
    const ctx = ownerCtx();
    const code = `consumer.email.${id('tpl')}`;
    db.insert(schema.messageTemplates)
      .values({
        id: id('tpl'),
        tenantId: TENANT,
        code,
        channel: 'email',
        version: 1,
        locale: 'en',
        subject: 'Renewal',
        body: 'Hi {{firstName}}, your membership ends on {{endsOn}}.',
        variables: ['firstName', 'endsOn'],
        updatedAt: now(),
      })
      .run();
    const created = createAutomation(ctx, {
      name: `Consumer email ${id('atm')}`,
      trigger: 'membership.expiring',
      description: 'P07 consumer probe',
      conditions: [],
      channel: 'email',
      templateCode: code,
      delayMin: 0,
      quietHours: { from: '00:00', to: '00:00' },
    });
    const automationId = created.automation.id;
    automationIds.push(automationId);
    updateAutomation(ctx, automationId, { state: 'active' });
    updateAutomation(ctx, automationId, { dryRun: false });

    const atMs = middayIST();
    const summary = runAutomation(ctx, automationId, atMs);
    expect(summary.sent).toBeGreaterThan(0);

    const deliveries = db
      .select()
      .from(schema.notificationDeliveries)
      .where(and(eq(schema.notificationDeliveries.source, 'automation'), eq(schema.notificationDeliveries.sourceId, automationId)))
      .all();
    expect(deliveries.length).toBe(summary.sent);
    expect(deliveries.every((d) => d.channel === 'email' && d.purpose === 'promotional' && d.state === 'queued')).toBe(true);

    const run = db.select().from(schema.automationRuns).where(and(eq(schema.automationRuns.automationId, automationId), eq(schema.automationRuns.outcome, 'sent'))).get()!;
    expect(run.reason).toMatch(/^Handed to the email channel \(delivery ndl_/);

    await processNotificationQueue(atMs);
    expect(driver.sent).toHaveLength(deliveries.length);
    const after = db.select().from(schema.notificationDeliveries).where(eq(schema.notificationDeliveries.id, deliveries[0]!.id)).get()!;
    expect(after).toMatchObject({ state: 'sent', provider: 'recording', providerMessageId: expect.stringMatching(/^rec_/) });
  });
});

describe('dunning through the NotificationService', () => {
  it('tells the member in the app and records the email step as its own attempt', async () => {
    const member = db
      .select({ id: schema.members.id, userId: schema.members.userId })
      .from(schema.members)
      .where(and(eq(schema.members.tenantId, TENANT), eq(schema.members.homeBranchId, 'br_kor')))
      .get()!;
    const invoiceId = id('inv');
    invoiceIds.push(invoiceId);
    db.insert(schema.invoices)
      .values({
        id: invoiceId,
        tenantId: TENANT,
        branchId: 'br_kor',
        memberId: member.id,
        number: `P07-${invoiceId.slice(-6)}`,
        state: 'overdue',
        issuedOn: '2026-01-01',
        dueOn: '2026-01-15',
        currency: 'INR',
        subtotalMinor: 250_000,
        discountMinor: 0,
        taxMinor: 0,
        totalMinor: 250_000,
        paidMinor: 0,
        refundedMinor: 0,
        voided: false,
        voidReason: null,
        refType: null,
        refId: null,
        createdAt: now(),
        updatedAt: now(),
      })
      .run();

    openDunning({ tenantId: TENANT }, { invoiceId, reason: 'Card declined' });
    db.update(schema.dunningAttempts).set({ channel: 'email' }).where(eq(schema.dunningAttempts.invoiceId, invoiceId)).run();
    const atMs = middayIST();
    runDueDunning(atMs);

    const rows = db
      .select()
      .from(schema.notificationDeliveries)
      .where(and(eq(schema.notificationDeliveries.source, 'dunning'), eq(schema.notificationDeliveries.sourceId, invoiceId)))
      .all();
    const inApp = rows.find((r) => r.channel === 'in_app')!;
    const email = rows.find((r) => r.channel === 'email')!;
    expect(inApp).toMatchObject({ state: 'sent', purpose: 'transactional', userId: member.userId, link: '/billing' });
    expect(email).toMatchObject({ state: 'queued', purpose: 'transactional' });

    await processNotificationQueue(atMs);
    const logged = db.select().from(schema.notificationDeliveries).where(eq(schema.notificationDeliveries.id, email.id)).get()!;
    // No email provider in tests: recorded truthfully, never "sent".
    expect(logged).toMatchObject({ state: 'logged', provider: 'log', reason: 'Logged, not delivered: no email provider is configured.' });
  });
});
