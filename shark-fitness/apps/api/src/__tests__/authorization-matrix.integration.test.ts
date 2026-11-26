import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Context, Next } from 'hono';
import type { ZodSchema } from 'zod';
import type { Role } from '@shark/contracts';
import { can, type Permission } from '@shark/domain';

/**
 * Authorization matrix (P08; PRD 05 §3.7 items 3–4; PRD 02 §14.2 "Cross-tenant
 * access attempt", "Branch permission boundary"; PRD 01 S11).
 *
 * Data-driven over every registered `/v1/admin/*` route, read from the app
 * itself, so a route added later is in the matrix without anyone listing it:
 *
 * 1. The owner calls the route. Every `requirePermission` check the request
 *    makes is recorded: that set is the route's permission. A route that
 *    checks none must be named in STAFF_WIDE with the reason.
 * 2. Reception, a trainer and an accountant call it. A role that lacks any
 *    permission the owner's call needed must be refused (403) — never served.
 * 3. Another gym's owner calls every route that names a record, with this
 *    gym's real ids. The answer must be 404: refused without revealing that
 *    the record exists (PRD 01 S11).
 *
 * Two test-only seams make that possible for 260 routes without a hand-written
 * body for each: `requirePermission` is observed (not changed), and body/query
 * validation lets invalid input through instead of answering 400 first, so the
 * permission and scope checks are what the response proves. Every request runs
 * inside a transaction that is rolled back, so the matrix changes nothing other
 * test files see, and it is left out of route coverage (route-recorder.ts):
 * coverage counts behavioural tests only.
 */

const observed = vi.hoisted(() => ({ checks: [] as Array<{ permission: string; allowed: boolean }> }));

vi.mock('../lib/context.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/context.js')>();
  const domain = await import('@shark/domain');
  return {
    ...actual,
    requirePermission: (ctx: Parameters<typeof actual.requirePermission>[0], permission: Permission) => {
      observed.checks.push({ permission, allowed: domain.can(ctx.role, permission) });
      return actual.requirePermission(ctx, permission);
    },
  };
});

vi.mock('../middleware/validate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/validate.js')>();
  return {
    ...actual,
    validate: (target: string, schema: ZodSchema) => async (c: Context, next: Next) => {
      let raw: unknown;
      if (target === 'json') raw = await c.req.json().catch(() => ({}));
      else if (target === 'query') raw = c.req.query();
      else if (target === 'param') raw = c.req.param();
      else if (target === 'form') raw = await c.req.parseBody().catch(() => ({}));
      else if (target === 'header') raw = c.req.header();
      else raw = {};
      const parsed = schema.safeParse(raw);
      (c.req as unknown as { addValidatedData(target: string, data: unknown): void }).addValidatedData(target, parsed.success ? parsed.data : raw);
      await next();
    },
  };
});

const { app } = await import('../app.js');
const { sqlite } = await import('../db/client.js');
const { signIn, headers } = await import('./helpers/session.js');
const { setPaymentProviderForTests } = await import('../lib/payment-provider.js');
const { createRazorpayProvider } = await import('../services/payments/razorpay.js');
type TestSession = Awaited<ReturnType<typeof signIn>>;

interface Answer {
  status: number;
  code?: string;
  message?: string;
  checks: Array<{ permission: string; allowed: boolean }>;
}

const ROLES: Array<{ role: Role; email: string }> = [
  { role: 'reception', email: 'reception@sharkfitness.in' },
  { role: 'trainer', email: 'rehan@sharkfitness.in' },
  { role: 'accountant', email: 'accounts@sharkfitness.in' },
];

/**
 * Admin routes any signed-in staff member may call, so no permission is
 * checked. Each needs a reason; anything else that checks no permission fails.
 */
const STAFF_WIDE: Record<string, string> = {
  'GET /v1/admin/search':
    'Command palette search: every result type is filtered by its own view permission inside consoleSearch (member.view, lead.view, billing.view, schedule.view, staff.view); proved below.',
  'GET /v1/admin/settings/timezones': 'The IANA timezone list plus the zones this gym already uses, for the branch form; no records.',
  'POST /v1/admin/billing/webhooks/demo': 'The retired payment simulator: answers 412 to everyone.',
};

/**
 * Routes whose permission is a choice (checked with `can`/`permissions.includes`
 * before `requirePermission`), or a role rather than a permission. The owner's
 * call cannot reveal those, so they are stated here and tested the same way.
 */
const RULES: Record<string, { anyOf?: Permission[]; ownerOnly?: true }> = {
  'POST /v1/admin/members/bulk/export': { anyOf: ['member.edit', 'report.export'] },
  'GET /v1/admin/billing/products': { anyOf: ['product.manage', 'membership.manage'] },
  'POST /v1/admin/security/staff/:staffId/mfa/reset': { ownerOnly: true },
};

/**
 * Valid bodies for routes whose services re-validate their input or need a
 * field before they reach the permission or scope check. Built for the caller,
 * so a branch in the body is always the caller's own: what is tested is the
 * record in the path, not a branch the caller could never name.
 */
function bodyFor(key: string, caller: { branchId: string }): Record<string, unknown> {
  const tomorrow = new Date(Date.now() + 86_400_000);
  const at = (hour: number) => new Date(Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), hour)).toISOString();
  switch (key) {
    case 'PATCH /v1/admin/members/:memberId/profile':
      return { firstName: 'Matrix', lastName: 'Check', dob: null, addressLine: null, emergencyContact: null, version: 1, reason: 'matrix check' };
    case 'PATCH /v1/admin/members/:memberId/identity':
      return { version: 1, email: 'matrix.check@example.com', phone: null, currentPassword: 'shark1234', identityVerified: true, reason: 'matrix check' };
    case 'POST /v1/admin/members/imports/preview':
      return { branchId: caller.branchId, csv: 'firstName,lastName\nMatrix,Check', mapping: {} };
    case 'POST /v1/admin/members/imports/commit':
      return { branchId: caller.branchId, csv: 'firstName,lastName\nMatrix,Check', mapping: {}, previewToken: '0.matrix', confirmed: true };
    case 'POST /v1/admin/privacy/requests':
      return { subjectUserId: memberUserId, kind: 'export', reason: null };
    case 'POST /v1/admin/privacy/requests/:id/review':
      return { decision: 'refuse', note: 'matrix check' };
    case 'POST /v1/admin/billing/credit-packs/:packId/refund':
      return { reason: 'matrix check' };
    case 'POST /v1/admin/community/content/:targetType/:targetId':
      return { action: 'hide', reason: 'matrix check' };
    case 'POST /v1/admin/schedule/session/:id/cancel':
      return { reason: 'matrix check', scope: 'occurrence' };
    case 'POST /v1/admin/schedule/series/:id/cancel':
      return { reason: 'matrix check', scope: 'series' };
    case 'POST /v1/admin/staff/:staffId/shifts':
      return { branchId: caller.branchId, startsAt: at(6), endsAt: at(10), role: 'floor', note: null };
    case 'POST /v1/admin/store/products/:productId/stock':
      return { branchId: caller.branchId, delta: 1, reason: 'count_correction', note: null, unitCostMinor: null, overrideReason: null };
    default:
      return {};
  }
}

/** Query strings for GET routes whose handlers need one. */
const QUERIES: Record<string, string> = { 'GET /v1/admin/search': '?q=an' };

/** Path parameters that are not record ids: a cross-tenant 404 does not apply. */
const NOT_A_RECORD = new Set(['targetType']);

/** One real Shark Fitness record per path parameter, by route area. */
function sharkId(table: string, where = '1 = 1'): string | null {
  const row = sqlite.prepare(`select id from ${table} where tenant_id = 'ten_shark' and ${where} limit 1`).get() as { id: string } | undefined;
  return row?.id ?? null;
}

const MISSING = 'zz_matrix_missing';

function idFor(path: string, param: string): string {
  const area = path.replace('/v1/admin/', '');
  const pick = (table: string, where?: string) => sharkId(table, where) ?? MISSING;
  switch (param) {
    case 'memberId':
      return pick('members');
    case 'leadId':
      return pick('leads');
    case 'invoiceId':
      return pick('invoices');
    case 'paymentId':
      return pick('payments');
    case 'productId':
      return area.startsWith('store/') ? pick('retail_products') : pick('products');
    case 'barcode': {
      const row = sqlite.prepare(`select barcode from retail_products where tenant_id = 'ten_shark' and barcode is not null limit 1`).get() as { barcode: string } | undefined;
      return row?.barcode ?? MISSING;
    }
    case 'automationId':
      return pick('automations');
    case 'packId':
      return pick('credit_packs');
    case 'exceptionId':
      return pick('payment_reconciliation_exceptions');
    case 'broadcastId':
      return pick('broadcasts');
    case 'checkInId':
      return pick('weekly_check_ins');
    case 'postId':
    case 'targetId':
      return pick('posts');
    case 'targetType':
      return 'post';
    case 'challengeId':
      return pick('challenges');
    case 'equipmentId':
      return pick('equipment');
    case 'workOrderId':
      return pick('work_orders');
    case 'taskId':
      return area.startsWith('facility/') ? pick('facility_tasks') : pick('tasks');
    case 'conversationId':
      return pick('conversations');
    case 'endpointId':
      return pick('webhook_endpoints');
    case 'deliveryId':
      return pick('webhook_deliveries');
    case 'staffId':
      // Not the owner: an owner may not reset their own two-step sign-in.
      return area.startsWith('security/') ? pick('staff', "user_id in (select id from users where role = 'reception')") : pick('staff');
    case 'lineId':
      return pick('commission_lines');
    case 'shiftId':
      return pick('shifts');
    case 'orderId':
      return pick('pos_orders');
    case 'transferId':
      return pick('stock_transfers');
    case 'ticketId':
      return pick('tickets');
    case 'interventionId':
      return pick('interventions');
    case 'assignmentId':
      return pick('assignments');
    case 'dayId':
      return pick('program_days');
    case 'exerciseId':
      return pick('exercises');
    case 'programId':
      return pick('programs');
    case 'itemId':
      return pick('program_items');
    case 'branchId':
      return pick('branches');
    case 'roomId':
      return pick('rooms');
    case 'id':
      if (area.startsWith('privacy/holds')) return pick('legal_holds');
      if (area.startsWith('privacy/requests')) return pick('privacy_requests');
      if (area.startsWith('schedule/booking')) return pick('bookings');
      if (area.startsWith('schedule/series')) return pick('class_series');
      if (area.startsWith('schedule/session')) return pick('class_sessions');
      if (area.startsWith('staff/unavailability')) return pick('staff_unavailability');
      throw new Error(`No id rule for ${path}`);
    default:
      throw new Error(`No id rule for :${param} in ${path}`);
  }
}

interface AdminRoute {
  key: string;
  method: string;
  pattern: string;
  path: string;
  /** Path parameters that name a record of this gym. */
  recordParams: string[];
}

const routes: AdminRoute[] = [];
{
  const seen = new Set<string>();
  for (const route of app.routes) {
    if (route.method === 'ALL' || !route.path.startsWith('/v1/admin/')) continue;
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const params = [...route.path.matchAll(/:([A-Za-z]+)/g)].map((match) => match[1]!);
    routes.push({ key, method: route.method, pattern: route.path, path: route.path, recordParams: params.filter((param) => !NOT_A_RECORD.has(param)) });
  }
  routes.sort((a, b) => a.key.localeCompare(b.key));
}

let sequence = 0;
async function ask(session: TestSession, route: AdminRoute, caller: { branchId: string } = SHARK_CALLER): Promise<Answer> {
  observed.checks.length = 0;
  sqlite.exec('SAVEPOINT authorization_matrix');
  try {
    const response = await app.request(`${route.path}${QUERIES[route.key] ?? ''}`, {
      method: route.method,
      headers: headers(session, { 'idempotency-key': `matrix-${++sequence}`, 'x-route-coverage': 'skip' }),
      ...(route.method === 'GET' || route.method === 'DELETE' ? {} : { body: JSON.stringify(bodyFor(route.key, caller)) }),
    });
    let code: string | undefined;
    let message: string | undefined;
    if ((response.headers.get('content-type') ?? '').includes('json')) {
      const body = (await response.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
      code = body.error?.code;
      message = body.error?.message;
    } else {
      await response.arrayBuffer();
    }
    return { status: response.status, code, message, checks: [...observed.checks] };
  } finally {
    sqlite.exec('ROLLBACK TO authorization_matrix');
    sqlite.exec('RELEASE authorization_matrix');
  }
}

const SHARK_CALLER = { branchId: 'br_kor' };
const REEF_CALLER = { branchId: 'brn_reef_main' };
let memberUserId = '';
const owner: { session?: TestSession } = {};
const staff = new Map<Role, TestSession>();
let reefOwner: TestSession;
const ownerAnswers = new Map<string, Answer>();

beforeAll(async () => {
  owner.session = await signIn('owner@sharkfitness.in', 'shark', true);
  for (const { role, email } of ROLES) staff.set(role, await signIn(email, 'shark', true));
  reefOwner = await signIn('owner@reefathletic.in', 'reef', true);
  memberUserId = (sqlite.prepare(`select id from users where tenant_id = 'ten_shark' and email = 'aman@sharkfitness.in'`).get() as { id: string }).id;
  for (const route of routes) {
    for (const param of [...route.pattern.matchAll(/:([A-Za-z]+)/g)].map((match) => match[1]!)) {
      route.path = route.path.replace(`:${param}`, encodeURIComponent(idFor(route.pattern, param)));
    }
  }
  for (const route of routes) ownerAnswers.set(route.key, await ask(owner.session!, route));
});

describe('[PRD05-3.7] authorization matrix over every admin route', () => {
  it('finds the admin routes', () => {
    expect(routes.length).toBeGreaterThan(200);
  });

  it('every admin route checks a permission (or is a documented staff-wide route)', () => {
    const unchecked = routes.filter(
      (route) => ownerAnswers.get(route.key)!.checks.length === 0 && !(route.key in STAFF_WIDE) && !(route.key in RULES),
    );
    expect(unchecked.map((route) => `${route.key} → ${ownerAnswers.get(route.key)!.status} ${ownerAnswers.get(route.key)!.code ?? ''}`)).toEqual([]);
  });

  for (const { role } of ROLES) {
    it(`[PRD02-14.2-branch-permission] ${role}: refused on every admin route whose permission the role lacks`, async () => {
      const session = staff.get(role)!;
      const leaks: string[] = [];
      let refused = 0;
      for (const route of routes) {
        const rule = RULES[route.key];
        const needed = [...new Set(ownerAnswers.get(route.key)!.checks.map((check) => check.permission as Permission))];
        const lacking = rule?.ownerOnly
          ? ['the owner role']
          : rule?.anyOf
            ? rule.anyOf.some((permission) => can(role, permission))
              ? []
              : [rule.anyOf.join(' or ')]
            : needed.filter((permission) => !can(role, permission));
        const answer = await ask(session, route);
        const failedCheck = answer.checks.some((check) => !check.allowed);
        if (failedCheck && answer.status !== 403) leaks.push(`${route.key}: a refused permission check answered ${answer.status}`);
        if (lacking.length === 0) continue;
        if (answer.status === 403) refused += 1;
        else leaks.push(`${route.key}: ${role} lacks ${lacking.join(', ')} but got ${answer.status} ${answer.code ?? ''}`);
      }
      expect(leaks).toEqual([]);
      expect(refused).toBeGreaterThan(0);
    });
  }

  it('regression: staff without settings.manage cannot raise a privacy request for a member', async () => {
    for (const role of ['reception', 'trainer', 'accountant'] as Role[]) {
      const response = await app.request('/v1/admin/privacy/requests', {
        method: 'POST',
        headers: headers(staff.get(role)!, { 'idempotency-key': `matrix-privacy-${role}`, 'x-route-coverage': 'skip' }),
        body: JSON.stringify({ subjectUserId: memberUserId, kind: 'deletion', reason: null }),
      });
      expect(response.status, role).toBe(403);
    }
  });

  it('palette search only returns the kinds of record each role may view', async () => {
    const viewPermission: Record<string, Permission> = {
      member: 'member.view',
      lead: 'lead.view',
      invoice: 'billing.view',
      class: 'schedule.view',
      staff: 'staff.view',
    };
    for (const [role, session] of [['owner', owner.session!], ...[...staff.entries()]] as Array<[Role, TestSession]>) {
      const response = await app.request('/v1/admin/search?q=an', { headers: headers(session, { 'x-route-coverage': 'skip' }) });
      expect(response.status).toBe(200);
      const { results } = (await response.json()) as { results: Array<{ type: string }> };
      expect(results.length, `${role} finds something`).toBeGreaterThan(0);
      const types = new Set(results.map((result) => result.type));
      for (const type of types) expect(can(role, viewPermission[type]!), `${role} may not see ${type} results`).toBe(true);
    }
  });

  it('[PRD01-S11] [PRD02-14.2-cross-tenant] another gym’s owner gets 404 for every route naming this gym’s records', async () => {
    // Online payment connected (to an address nothing listens on): a route that
    // reached the provider for another gym's invoice would fail loudly here,
    // instead of every caller being turned away by "not connected" first.
    setPaymentProviderForTests(
      createRazorpayProvider({ keyId: 'rzp_test_matrix', keySecret: 'matrix', webhookSecret: 'matrix', apiBase: 'http://127.0.0.1:9', timeoutMs: 200 }),
    );
    const leaks: string[] = [];
    let checked = 0;
    for (const route of routes.filter((candidate) => candidate.recordParams.length > 0)) {
      if (route.path.includes(MISSING)) continue;
      checked += 1;
      const answer = await ask(reefOwner, route, REEF_CALLER);
      if (answer.status !== 404) leaks.push(`${route.key} → ${answer.status} ${answer.code ?? ''} ${answer.message ?? ''}`);
    }
    setPaymentProviderForTests(undefined);
    expect(leaks).toEqual([]);
    expect(checked).toBeGreaterThan(100);
  });
});
