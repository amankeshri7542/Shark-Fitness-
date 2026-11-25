import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { resetRateLimitsForTest } from '../middleware/index.js';
import { hashToken as hashOf } from '../lib/crypto.js';
import { id } from '../lib/ids.js';
import { MINUTE, now } from '../lib/time.js';
import { Browser, addStaff, auditActions } from './helpers/browser.js';
import { testTotp } from './helpers/mfa.js';

/**
 * PRD 01 §2.4 / PRD 02 "Authorization sequence" step 6: every high-risk route
 * answers 401 STEP_UP_REQUIRED without a re-authentication in the last five
 * minutes, and goes through once the person re-proves who they are.
 */

const SHARK = db.select().from(schema.tenants).where(eq(schema.tenants.slug, 'shark')).get()!;

afterEach(() => vi.useRealTimers());
// The webhook cases create endpoints on the demo gym pointing at
// hooks.example.com. Retire them so no later suite's dispatcher tries them.
afterAll(() => {
  db.update(schema.webhookEndpoints)
    .set({ deletedAt: now(), state: 'paused' })
    .where(and(eq(schema.webhookEndpoints.tenantId, SHARK.id), sql`${schema.webhookEndpoints.url} like 'https://hooks.example.com/%'`))
    .run();
});
beforeEach(() => resetRateLimitsForTest());

/** A full owner session: password plus the test authenticator code. */
async function signInMfa(email: string, tenant = 'shark', password = 'shark1234'): Promise<Browser & { userId: string }> {
  const browser = new Browser() as Browser & { userId: string };
  const signIn = await browser.signIn(tenant, email, password);
  expect(signIn.status).toBe(200);
  browser.userId = signIn.body.viewer.userId;
  if (signIn.body.mfa.state === 'challenge') {
    expect((await browser.request('/auth/mfa/verify', { body: { code: testTotp(browser.userId) } })).status).toBe(200);
  }
  return browser;
}

/** Ages the session's last proof so the next high-risk call needs a step-up. */
function makeStale(browser: Browser): void {
  const session = db.select().from(schema.sessions).where(sql`token_hash = ${hashOf(browser.session!)}`).get()!;
  db.update(schema.sessions).set({ reauthenticatedAt: now() - 6 * MINUTE }).where(eq(schema.sessions.id, session.id)).run();
}

/** A fresh open invoice of our own, copied from a seeded one, so this suite
 *  never changes the seeded figures other suites read. */
function freshInvoice(): typeof schema.invoices.$inferSelect {
  const template = db
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.tenantId, SHARK.id), inArray(schema.invoices.state, ['open', 'overdue']), gt(schema.invoices.totalMinor, 10_000)))
    .get()!;
  const invoiceId = id('inv');
  const row = { ...template, id: invoiceId, number: `SU-${invoiceId.slice(-8).toUpperCase()}`, state: 'open', paidMinor: 0, refundedMinor: 0, refType: null, refId: null, createdAt: now(), updatedAt: now() };
  db.insert(schema.invoices).values(row).run();
  return db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId)).get()!;
}

function freshProduct(): string {
  const productId = id('rtl');
  const unique = productId.slice(-8).toUpperCase();
  db.insert(schema.retailProducts)
    .values({
      id: productId, tenantId: SHARK.id, name: `Step-up Item ${unique}`, sku: `SU-${unique}`, barcode: `998${unique}`,
      category: 'Accessories', groupId: null, variantName: '', supplierId: null, priceMinor: 100_000, costMinor: 40_000,
      taxRateBp: 1800, reorderAt: 0, active: true, createdAt: now(),
    })
    .run();
  db.insert(schema.stockLedger)
    .values({
      id: id('stk'), tenantId: SHARK.id, branchId: 'br_kor', productId, delta: 10, reason: 'purchase', refType: null, refId: null,
      actorName: 'seed', note: 'step-up fixture', unitCostMinor: 40_000, negativeOverride: false, overrideReason: null, at: now(),
    })
    .run();
  return productId;
}

function memberSubject(): string {
  const userId = id('usr');
  db.insert(schema.users)
    .values({
      id: userId, tenantId: SHARK.id, email: `${userId}@stepup.test`, phone: null, name: 'Step-up Subject', initials: 'SS',
      role: 'member', accountState: 'active', passwordHash: null, preferences: {}, lastSeenAt: null, createdAt: now(), updatedAt: now(),
    })
    .run();
  return userId;
}

interface Case {
  name: string;
  action: string;
  /** Builds the request; may create fixtures through the owner's session. */
  prepare: (owner: Browser) => Promise<{ method: string; path: string; body?: unknown; as?: Browser }>;
  ok: number[];
}

const CASES: Case[] = [
  {
    name: 'refund a payment',
    action: 'billing.refund',
    ok: [200],
    prepare: async (owner) => {
      const invoice = freshInvoice();
      // Paid and refunded in full, so the invoice ends settled rather than
      // half-open in other suites' outstanding totals.
      const paid = await owner.json<{ paymentId: string }>(`/admin/billing/invoices/${invoice.id}/payments`, {
        body: { method: 'cash', amountMinor: invoice.totalMinor, idempotencyKey: id('idem') },
      });
      expect(paid.status).toBe(200);
      return { method: 'POST', path: `/admin/billing/payments/${paid.body.paymentId}/refund`, body: { amountMinor: invoice.totalMinor, reason: 'Charged twice at the desk' } };
    },
  },
  {
    name: 'write off (void) an invoice',
    action: 'billing.write_off',
    ok: [200],
    prepare: async () => {
      const invoice = freshInvoice();
      return { method: 'POST', path: `/admin/billing/invoices/${invoice.id}/void`, body: { reason: 'Raised against the wrong member' } };
    },
  },
  {
    name: 'refund a store sale',
    action: 'store.refund',
    ok: [201],
    prepare: async (owner) => {
      const productId = freshProduct();
      const sale = await owner.json<{ order: { id: string }; lines: Array<{ id: string }> }>('/admin/store/orders', {
        body: { branchId: 'br_kor', lines: [{ productId, quantity: 1 }], payments: [{ method: 'cash', amountMinor: 118_000 }] },
      });
      expect(sale.status).toBe(201);
      return { method: 'POST', path: `/admin/store/orders/${sale.body.order.id}/refund`, body: { reason: 'Wrong size for the customer', lines: [{ lineId: sale.body.lines[0]!.id, quantity: 1 }] } };
    },
  },
  {
    name: 'create a member of staff (a role grant)',
    action: 'staff.create',
    ok: [201],
    prepare: async () => ({
      method: 'POST',
      path: '/admin/staff',
      body: { name: 'New Desk Hire', email: `${id('hire')}@stepup.test`, role: 'reception', branchIds: ['br_kor'] },
    }),
  },
  {
    name: 'change a colleague’s role',
    action: 'staff.access_change',
    ok: [200],
    prepare: async () => {
      const desk = addStaff(SHARK.id, ['br_kor'], 'reception');
      return { method: 'PATCH', path: `/admin/staff/${desk.staffId}`, body: { role: 'branch_manager' } };
    },
  },
  {
    name: 'change a colleague’s branches',
    action: 'staff.access_change',
    ok: [200],
    prepare: async () => {
      const desk = addStaff(SHARK.id, ['br_kor'], 'reception');
      return { method: 'PATCH', path: `/admin/staff/${desk.staffId}`, body: { branchIds: ['br_kor', 'br_ind'] } };
    },
  },
  {
    name: 'export a report',
    action: 'report.export',
    ok: [200],
    prepare: async () => ({ method: 'POST', path: '/admin/reports/export', body: { kind: 'attendance', from: '2026-05-21', to: '2026-06-18' } }),
  },
  {
    name: 'export members',
    action: 'member.export',
    ok: [200],
    prepare: async () => {
      const ids = db.select({ id: schema.members.id }).from(schema.members).where(eq(schema.members.tenantId, SHARK.id)).limit(3).all().map((row) => row.id);
      return { method: 'POST', path: '/admin/members/bulk/export', body: { memberIds: ids } };
    },
  },
  {
    name: 'build a privacy export package',
    action: 'privacy.export',
    ok: [201],
    prepare: async (owner) => {
      const raised = await owner.json<{ requestId: string }>('/admin/privacy/requests', { body: { subjectUserId: memberSubject(), kind: 'export', reason: null } });
      expect(raised.status).toBe(201);
      return { method: 'POST', path: `/admin/privacy/requests/${raised.body.requestId}/export` };
    },
  },
  {
    name: 'approve a deletion request',
    action: 'privacy.deletion_approve',
    ok: [200],
    prepare: async (owner) => {
      const raised = await owner.json<{ requestId: string }>('/admin/privacy/requests', { body: { subjectUserId: memberSubject(), kind: 'deletion', reason: null } });
      return { method: 'POST', path: `/admin/privacy/requests/${raised.body.requestId}/review`, body: { decision: 'accept', note: 'Identity confirmed at the desk' } };
    },
  },
  {
    name: 'erase a member',
    action: 'privacy.erase',
    // The erasure itself may still be refused by retention rules (412); what
    // is under test is that the step-up gate no longer stands in the way.
    ok: [200, 412],
    prepare: async (owner) => {
      const raised = await owner.json<{ requestId: string }>('/admin/privacy/requests', { body: { subjectUserId: memberSubject(), kind: 'deletion', reason: null } });
      return { method: 'POST', path: `/admin/privacy/requests/${raised.body.requestId}/erase` };
    },
  },
  {
    name: 'change the gym’s sign-in security settings',
    action: 'settings.security',
    ok: [200],
    prepare: async () => ({ method: 'PATCH', path: '/admin/security/settings', body: { staffIdleTimeoutMinutes: 30 } }),
  },
  {
    name: 'reset a colleague’s two-step sign-in',
    action: 'staff.mfa_reset',
    ok: [200],
    prepare: async () => {
      const desk = addStaff(SHARK.id, ['br_kor'], 'reception');
      return { method: 'POST', path: `/admin/security/staff/${desk.staffId}/mfa/reset`, body: { reason: 'Lost phone, identity checked in person' } };
    },
  },
  {
    name: 'regenerate recovery codes',
    action: 'auth.mfa_recovery_codes',
    ok: [200],
    prepare: async () => ({ method: 'POST', path: '/auth/mfa/recovery-codes' }),
  },
  {
    name: 'create a webhook endpoint (a channel out of the building)',
    action: 'webhook.create',
    ok: [201],
    prepare: async () => ({ method: 'POST', path: '/admin/integrations/webhooks', body: { url: 'https://hooks.example.com/shark', events: ['lead.created'] } }),
  },
  {
    name: 'point a webhook at a new URL',
    action: 'webhook.change_url',
    ok: [200],
    prepare: async (owner) => {
      const created = await owner.json<{ endpoint: { id: string } }>('/admin/integrations/webhooks', { body: { url: 'https://hooks.example.com/a', events: ['lead.created'] } });
      return { method: 'PATCH', path: `/admin/integrations/webhooks/${created.body.endpoint.id}`, body: { url: 'https://hooks.example.com/b' } };
    },
  },
  {
    name: 'rotate a webhook signing secret',
    action: 'webhook.rotate_secret',
    ok: [200],
    prepare: async (owner) => {
      const created = await owner.json<{ endpoint: { id: string } }>('/admin/integrations/webhooks', { body: { url: 'https://hooks.example.com/c', events: ['lead.created'] } });
      return { method: 'POST', path: `/admin/integrations/webhooks/${created.body.endpoint.id}/rotate-secret` };
    },
  },
  {
    name: 'reveal a webhook signing secret',
    action: 'webhook.reveal_secret',
    ok: [200],
    prepare: async (owner) => {
      const created = await owner.json<{ endpoint: { id: string } }>('/admin/integrations/webhooks', { body: { url: 'https://hooks.example.com/d', events: ['lead.created'] } });
      return { method: 'GET', path: `/admin/integrations/webhooks/${created.body.endpoint.id}/secret` };
    },
  },
  {
    name: 'start a support (impersonation) session',
    action: 'platform.impersonate',
    ok: [200],
    prepare: async () => {
      const operator = await signInMfa('platform@sharkfitness.io', 'platform');
      const target = db.select().from(schema.users).where(and(eq(schema.users.tenantId, SHARK.id), eq(schema.users.email, 'reception@sharkfitness.in'))).get()!;
      return { method: 'POST', path: '/platform/impersonate', body: { userId: target.id, reason: 'Ticket 4411: desk cannot see today’s classes' }, as: operator };
    },
  },
];

describe('high-risk routes require a recent re-authentication', () => {
  let owner: Browser & { userId: string };
  beforeAll(async () => {
    resetRateLimitsForTest();
    owner = await signInMfa('owner@sharkfitness.in');
  });

  it.each(CASES)('$name → STEP_UP_REQUIRED, then succeeds after step-up', async (testCase) => {
    const request = await testCase.prepare(owner);
    const browser = (request.as ?? owner) as Browser & { userId: string };
    const userId = db.select({ userId: schema.sessions.userId }).from(schema.sessions).where(sql`token_hash = ${hashOf(browser.session!)}`).get()!.userId;
    makeStale(browser);

    const refused = await browser.json<{ error: { code: string; details: { action: string; mfa: boolean; maxAgeSec: number } } }>(request.path, {
      method: request.method,
      ...(request.body !== undefined ? { body: request.body } : {}),
    });
    expect(refused.status).toBe(401);
    expect(refused.body.error).toMatchObject({ code: 'STEP_UP_REQUIRED', details: { action: testCase.action, mfa: true, maxAgeSec: 300 } });

    const stepUp = await browser.request('/auth/step-up', { body: { password: 'shark1234', code: testTotp(userId) } });
    expect(stepUp.status).toBe(200);

    // Still inside the five minutes.
    vi.useFakeTimers({ toFake: ['Date'], now: now() + 4 * MINUTE });
    const allowed = await browser.request(request.path, { method: request.method, ...(request.body !== undefined ? { body: request.body } : {}) });
    expect(testCase.ok, await allowed.clone().text()).toContain(allowed.status);
    vi.useRealTimers();
  });

  it('records refused attempts with the action only, never the request body', async () => {
    makeStale(owner);
    await owner.request('/admin/reports/export', { body: { kind: 'attendance', from: '2026-05-21', to: '2026-06-18' } });
    const row = db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.tenantId, SHARK.id), eq(schema.auditLog.action, 'auth.step_up_required')))
      .orderBy(sql`at desc`)
      .get()!;
    expect(row.entityLabel).toBe('report.export');
    expect(JSON.stringify(row)).not.toContain('2026-05-21');
    expect(row.changes).toEqual([]);
  });

  it('expires five minutes after the re-check', async () => {
    const browser = await signInMfa('owner@sharkfitness.in');
    vi.useFakeTimers({ toFake: ['Date'], now: now() + 5 * MINUTE + 5_000 });
    await browser.request('/auth/session/activity', { method: 'POST' });
    const refused = await browser.json<{ error: { code: string } }>('/admin/reports/export', { body: { kind: 'attendance', from: '2026-05-21', to: '2026-06-18' } });
    expect(refused.body.error.code).toBe('STEP_UP_REQUIRED');
  });

  it('refuses a wrong password or code and audits the failure', async () => {
    const browser = await signInMfa('owner@sharkfitness.in');
    expect((await browser.request('/auth/step-up', { body: { password: 'not-the-password' } })).status).toBe(422);
    const wrongCode = testTotp(browser.userId) === '000000' ? '111111' : '000000';
    expect((await browser.request('/auth/step-up', { body: { password: 'shark1234', code: wrongCode } })).status).toBe(422);
    expect(auditActions(SHARK.id).filter((action) => action === 'auth.step_up_failed').length).toBeGreaterThanOrEqual(2);
  });

  it('asks staff without MFA for their password only', async () => {
    const desk = addStaff(SHARK.id, ['br_kor'], 'branch_manager');
    const browser = new Browser();
    expect((await browser.signIn('shark', desk.email, desk.password)).body.mfa.state).toBe('none');
    makeStale(browser);
    const refused = await browser.json<{ error: { details: { mfa: boolean } } }>('/admin/reports/export', { body: { kind: 'attendance', from: '2026-05-21', to: '2026-06-18' } });
    expect(refused.body.error.details.mfa).toBe(false);
    expect((await browser.request('/auth/step-up', { body: { password: desk.password } })).status).toBe(200);
    expect((await browser.request('/admin/reports/export', { body: { kind: 'attendance', from: '2026-05-21', to: '2026-06-18' } })).status).toBe(200);
  });

  it('does not ask for a step-up on ordinary staff edits', async () => {
    const desk = addStaff(SHARK.id, ['br_kor'], 'reception');
    makeStale(owner);
    expect((await owner.request(`/admin/staff/${desk.staffId}`, { method: 'PATCH', body: { name: 'Renamed Desk' } })).status).toBe(200);
  });
});

describe('support sessions', () => {
  it('re-proves the operator, and only the impersonated session can end itself', async () => {
    const operator = await signInMfa('platform@sharkfitness.io', 'platform');
    const target = db.select().from(schema.users).where(and(eq(schema.users.tenantId, SHARK.id), eq(schema.users.email, 'reception@sharkfitness.in'))).get()!;
    const started = await operator.request('/platform/impersonate', { body: { userId: target.id, reason: 'Ticket 4412: checking the desk view' } });
    expect(started.status).toBe(200);
    // The operator's browser now holds the support session.
    makeStale(operator);
    const refused = await operator.json<{ error: { code: string } }>('/admin/reports/export', { body: { kind: 'attendance', from: '2026-05-21', to: '2026-06-18' } });
    // Reception may not export at all, so the permission refusal comes first.
    expect(refused.status).toBe(403);
    // It is the operator who re-proves: they have MFA (reception does not), so a
    // password alone is refused for want of a code, and their code completes it.
    const noCode = await operator.json<{ error: { fields: Array<{ path: string }> } }>('/auth/step-up', { body: { password: 'shark1234' } });
    expect(noCode.status).toBe(422);
    expect(noCode.body.error.fields[0]?.path).toBe('code');
    const platformAdmin = db.select().from(schema.users).where(eq(schema.users.email, 'platform@sharkfitness.io')).get()!;
    expect((await operator.request('/auth/step-up', { body: { password: 'shark1234', code: testTotp(platformAdmin.id) } })).status).toBe(200);

    // /platform/impersonate/end: signed out → 401; an ordinary session → 412; the support session → ends itself.
    expect((await new Browser().request('/platform/impersonate/end', { method: 'POST' })).status).toBe(401);
    const ordinary = await signInMfa('owner@sharkfitness.in');
    expect((await ordinary.request('/platform/impersonate/end', { method: 'POST' })).status).toBe(412);
    expect((await operator.request('/platform/impersonate/end', { method: 'POST' })).status).toBe(200);
    expect((await operator.request('/me')).status).toBe(401);
    expect((await ordinary.request('/me')).status).toBe(200);
  });
});
