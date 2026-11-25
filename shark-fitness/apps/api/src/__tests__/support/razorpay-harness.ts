import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { expect } from 'vitest';
import { app } from '../../app.js';
import { db, schema, sqlite } from '../../db/client.js';
import { id } from '../../lib/ids.js';
import { setPaymentProviderForTests, type PaymentProvider } from '../../lib/payment-provider.js';
import { now } from '../../lib/time.js';
import { resetRateLimitsForTest } from '../../middleware/index.js';
import { createRazorpayProvider } from '../../services/payments/razorpay.js';
import { startFakeRazorpay, webhookBody, webhookSignature, type FakeRazorpay, type WebhookEntities } from '../../testing/razorpay-fake.js';

/**
 * Shared set-up for the Razorpay integration tests.
 *
 * - The real adapter, pointed at a local fake Razorpay (src/testing).
 * - Every provider call is recorded, and any call made while a SQLite
 *   transaction is open is recorded separately (P02 acceptance 8).
 * - `fetch` to anything but the loopback fake throws and is recorded, so an
 *   unexpected outbound request fails the test (P02 acceptance 3).
 */

export const ORIGIN = 'http://localhost:5173';
export type Session = { cookie: string; 'x-csrf-token': string };

export interface Harness {
  fake: FakeRazorpay;
  provider: PaymentProvider;
  calls: string[];
  callsInsideTransaction: string[];
  outbound: string[];
  /** Asserts no unexpected outbound or fake request and no provider call
   *  inside a transaction. */
  assertClean(): void;
  close(): Promise<void>;
}

export async function startHarness(options: { timeoutMs?: number } = {}): Promise<Harness> {
  const fake = await startFakeRazorpay();
  const real = createRazorpayProvider({
    keyId: fake.keyId,
    keySecret: fake.keySecret,
    webhookSecret: fake.webhookSecret,
    apiBase: fake.baseUrl,
    timeoutMs: options.timeoutMs ?? 400,
  });
  const calls: string[] = [];
  const callsInsideTransaction: string[] = [];
  const provider = Object.fromEntries(
    Object.entries(real).map(([name, value]) => [
      name,
      typeof value === 'function'
        ? (...args: unknown[]) => {
            calls.push(name);
            if (sqlite.inTransaction) callsInsideTransaction.push(name);
            return (value as (...inner: unknown[]) => unknown)(...args);
          }
        : value,
    ]),
  ) as unknown as PaymentProvider;
  setPaymentProviderForTests(provider);

  const realFetch = globalThis.fetch;
  const outbound: string[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== '127.0.0.1') {
      outbound.push(url.href);
      return Promise.reject(new Error(`Unexpected outbound request to ${url.href}`));
    }
    return realFetch(input, init);
  }) as typeof fetch;

  return {
    fake,
    provider,
    calls,
    callsInsideTransaction,
    outbound,
    assertClean() {
      expect(outbound, 'outbound requests outside the fake').toEqual([]);
      expect(fake.unexpected.map((request) => `${request.method} ${request.path}`), 'requests the fake does not serve').toEqual([]);
      expect(callsInsideTransaction, 'provider calls inside transact()').toEqual([]);
    },
    async close() {
      setPaymentProviderForTests(undefined);
      globalThis.fetch = realFetch;
      await fake.close();
    },
  };
}

export async function signIn(email: string): Promise<Session> {
  resetRateLimitsForTest();
  const response = await app.request('/v1/auth/password', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ tenantSlug: 'shark', email, password: 'shark1234' }),
  });
  expect(response.status).toBe(200);
  const { csrfToken } = (await response.json()) as { csrfToken: string };
  const token = response.headers.get('set-cookie')!.match(/shark_session=([^;,]+)/)![1];
  return { cookie: `shark_session=${token}; shark_csrf=${csrfToken}`, 'x-csrf-token': csrfToken };
}

export function request(method: 'GET' | 'POST', path: string, session: Session, body?: unknown, key?: string | null) {
  return app.request(`/v1${path}`, {
    method,
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      ...session,
      ...(key === null ? {} : { 'idempotency-key': key ?? randomUUID() }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** A member of their own (cloned from the demo member Aman, same password),
 *  so activating memberships here cannot disturb other test files. */
export function createMember(label: string): { memberId: string; email: string; tenantId: string; branchId: string } {
  const aman = db.select().from(schema.members).where(eq(schema.members.email, 'aman@sharkfitness.in')).get()!;
  const amanUser = db.select().from(schema.users).where(eq(schema.users.id, aman.userId!)).get()!;
  const suffix = randomUUID().slice(0, 8);
  const email = `rzp-${label}-${suffix}@example.com`;
  const userId = id('usr');
  db.insert(schema.users).values({ ...amanUser, id: userId, email, phone: null, name: `Razorpay ${label}`, createdAt: now(), updatedAt: now() }).run();
  const memberId = id('mbr');
  db.insert(schema.members)
    .values({ ...aman, id: memberId, userId, email, emailNormalized: email, phone: null, phoneNormalized: null, memberNo: `RZP-${suffix}`, firstName: 'Razorpay', lastName: label, lifecycle: 'trial', version: 1, createdAt: now(), updatedAt: now() })
    .run();
  return { memberId, email, tenantId: aman.tenantId, branchId: aman.homeBranchId };
}

/** An open invoice for a pending membership, the way reception's plan
 *  assignment leaves one. */
export function openInvoice(member: { memberId: string; tenantId: string; branchId: string }, totalMinor = 29_500) {
  const template = db.select().from(schema.memberships).where(eq(schema.memberships.tenantId, member.tenantId)).get()!;
  const membershipId = id('msh');
  db.insert(schema.memberships)
    .values({ ...template, id: membershipId, memberId: member.memberId, state: 'pending_payment', previousMembershipId: null, version: 1, createdAt: now(), updatedAt: now() })
    .run();
  const invoiceId = id('inv');
  db.insert(schema.invoices)
    .values({
      id: invoiceId, tenantId: member.tenantId, branchId: member.branchId, memberId: member.memberId, number: `RZP-${randomUUID().slice(0, 12)}`,
      state: 'open', issuedOn: '2026-11-25', dueOn: '2099-12-31', currency: 'INR', subtotalMinor: totalMinor, discountMinor: 0, taxMinor: 0,
      totalMinor, paidMinor: 0, refundedMinor: 0, voided: false, voidReason: null, refType: 'membership', refId: membershipId, createdAt: now(), updatedAt: now(),
    })
    .run();
  return { invoiceId, membershipId };
}

export function invoiceRow(invoiceId: string) {
  return db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId)).get()!;
}

export function paymentsFor(invoiceId: string) {
  return db.select().from(schema.payments).where(eq(schema.payments.invoiceId, invoiceId)).all();
}

export function membershipRow(membershipId: string) {
  return db.select().from(schema.memberships).where(eq(schema.memberships.id, membershipId)).get()!;
}

export function intentRow(intentId: string) {
  return db.select().from(schema.paymentIntents).where(eq(schema.paymentIntents.id, intentId)).get()!;
}

export function auditFor(entityId: string, action: string) {
  return db.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityId, entityId), eq(schema.auditLog.action, action))).all();
}

export function outboxFor(memberId: string, topic: string) {
  return sqlite
    .prepare('select * from outbox_events where channel = ? and topic = ?')
    .all(`member:${memberId}`, topic) as Array<{ payload: string }>;
}

export function exceptionsFor(invoiceId: string) {
  return db.select().from(schema.paymentReconciliationExceptions).where(eq(schema.paymentReconciliationExceptions.invoiceId, invoiceId)).all();
}

export async function postWebhook(
  harness: Harness,
  event: string,
  entities: WebhookEntities,
  options: { eventId?: string; signature?: string | null; tamper?: (body: string) => string } = {},
) {
  const body = webhookBody(event, entities);
  const signature = options.signature === undefined ? webhookSignature(body, harness.fake.webhookSecret) : options.signature;
  return app.request('/v1/webhooks/razorpay', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-event-id': options.eventId ?? `evt_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
      ...(signature === null ? {} : { 'x-razorpay-signature': signature }),
    },
    body: options.tamper ? options.tamper(body) : body,
  });
}

/** Start checkout for an invoice and return the session JSON. */
export async function checkout(session: Session, invoiceId: string, key?: string) {
  const response = await request('POST', `/member/billing/invoices/${invoiceId}/checkout`, session, undefined, key);
  return { response, body: (await response.json()) as Record<string, unknown> & { intentId: string; orderId: string; state: string } };
}
