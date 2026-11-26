import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ZodTypeAny } from 'zod';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { getTableConfig, type SQLiteColumn, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { hashPassword } from '../lib/crypto.js';
import { id as newId } from '../lib/ids.js';
import { now } from '../lib/time.js';
import { authenticate, isRateLimiter, resetRateLimitsForTest } from '../middleware/index.js';
import { validatorSchemaOf } from '../middleware/validate.js';
import { chainFor, concretePath, listRoutes, MUTATING_METHODS, paramsOf, type RouteInfo } from './helpers/routes.js';
import { call, signIn, type TestSession } from './helpers/session.js';
import { sampleValid } from './helpers/zod-sample.js';
import { startHarness, type Harness } from './support/razorpay-harness.js';
import { signMediaPath } from '../lib/media-storage.js';
import { signMediaUrl } from '../services/media.js';
import { attachmentPath } from '../services/messaging.js';

/**
 * P09 security review: three properties checked over the *whole* route table,
 * read from Hono at run time, so a route added later is covered without
 * anybody remembering to add it here (ASVS V4.2.2, V4.1.1, V2.2.1, V13.1.4).
 *
 * 1. CSRF: every state-changing route refuses a browser session that does not
 *    send the double-submit token, and refuses a foreign Origin, except the
 *    documented exemptions in lib/security.ts.
 * 2. Rate limits: every route reachable without a full session runs a rate
 *    limiter before its handler.
 * 3. IDOR: every route with an id in its path answers 404 when a signed-in
 *    person of another gym sends a real id of this gym — not 403, and never
 *    the record.
 */

const ORIGIN = 'http://localhost:5173';
const SHARK = 'ten_shark';
const routes = listRoutes();

beforeEach(() => resetRateLimitsForTest());

function codeOf(body: unknown): string | undefined {
  return (body as { error?: { code?: string } } | null)?.error?.code;
}

/* ------------------------------------------------------------------------ */
/* 1. CSRF                                                                   */
/* ------------------------------------------------------------------------ */

/** Mutating routes that a session cookie without a CSRF token may reach, each
 *  with the reason (mirrors lib/security.ts; a new entry needs a review). */
const CSRF_TOKEN_EXEMPT: Array<[RegExp, string]> = [
  [/^\/v1\/auth\/(password|otp\/start|otp\/verify|activation\/redeem|recovery\/redeem)$/, 'session entry: Origin check is the boundary; a stale cookie must not lock the person out'],
  [/^\/v1\/client-errors$/, 'write-only crash reporter; demands an Origin itself'],
  [/^\/v1\/public\/:tenantSlug\//, 'public website forms act on no session; demand a known Origin'],
  [/^\/v1\/webhooks\//, 'server-to-server; provider signature over the raw body'],
  [/^\/v1\/csp-reports$/, 'browser-sent violation reports; store nothing, size-capped and limited'],
];
/** Mutating routes that also skip the Origin check (no browser sends them). */
const ORIGIN_EXEMPT: Array<[RegExp, string]> = [
  [/^\/v1\/webhooks\//, 'server-to-server; provider signature over the raw body'],
  [/^\/v1\/csp-reports$/, 'browsers often send Origin: null for reports'],
];

const exempt = (list: Array<[RegExp, string]>, path: string) => list.some(([pattern]) => pattern.test(path));

describe('[P09-SEC-CSRF] every state-changing route is behind the CSRF check', () => {
  const mutating = routes.filter((route) => MUTATING_METHODS.has(route.method));
  let owner: TestSession;

  beforeAll(async () => {
    owner = await signIn('owner@sharkfitness.in');
  });

  it('enumerates the mutating routes', () => {
    expect(mutating.length).toBeGreaterThan(150);
  });

  it('serves every mutating route under /v1, where the CSRF middleware runs', () => {
    expect(mutating.filter((route) => !route.path.startsWith('/v1/')).map((r) => `${r.method} ${r.path}`)).toEqual([]);
  });

  it('refuses every non-exempt mutating route when a session sends no CSRF token', async () => {
    const unprotected: string[] = [];
    for (const route of mutating) {
      if (exempt(CSRF_TOKEN_EXEMPT, route.path)) continue;
      const response = await app.request(concretePath(route.path, () => 'csrf-probe'), {
        method: route.method,
        headers: { cookie: owner.cookie, origin: ORIGIN, 'content-type': 'application/json' },
        body: '{}',
      });
      const body = await response.json().catch(() => null);
      if (response.status !== 403 || codeOf(body) !== 'FORBIDDEN') unprotected.push(`${route.method} ${route.path} → ${response.status}`);
    }
    expect(unprotected).toEqual([]);
  });

  it('refuses every non-exempt mutating route from a foreign Origin, even with a valid token', async () => {
    const unprotected: string[] = [];
    for (const route of mutating) {
      if (exempt(ORIGIN_EXEMPT, route.path)) continue;
      const response = await app.request(concretePath(route.path, () => 'csrf-probe'), {
        method: route.method,
        headers: { cookie: owner.cookie, origin: 'https://evil.example', 'x-csrf-token': owner.csrfToken, 'content-type': 'application/json' },
        body: '{}',
      });
      if (response.status !== 403) unprotected.push(`${route.method} ${route.path} → ${response.status}`);
    }
    expect(unprotected).toEqual([]);
  });

  it('keeps the exemption list honest: each exemption still matches a route', () => {
    for (const [pattern, reason] of [...CSRF_TOKEN_EXEMPT, ...ORIGIN_EXEMPT]) {
      expect(mutating.some((route) => pattern.test(route.path)), `${pattern} (${reason})`).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------------ */
/* 2. Rate limits on every unauthenticated route                             */
/* ------------------------------------------------------------------------ */

/** Unauthenticated routes allowed to run without a limiter, with the reason. */
const UNLIMITED_PUBLIC: Record<string, string> = {
  'GET /health': 'liveness probe for the host and Caddy; constant response, no I/O',
  'GET /ready': 'readiness probe; one cheap SELECT 1, polled by the platform',
  'GET /.well-known/assetlinks.json': 'static Digital Asset Links document for the Android TWA',
};

describe('[P09-SEC-RATE] every unauthenticated route is rate limited', () => {
  it('finds a limiter in the chain of every route that does not require a full session', () => {
    const unlimited: string[] = [];
    let checked = 0;
    for (const route of routes) {
      const chain = chainFor(route);
      if (chain.includes(authenticate)) continue;
      checked += 1;
      if (chain.some(isRateLimiter)) continue;
      const key = `${route.method} ${route.path}`;
      if (key in UNLIMITED_PUBLIC) continue;
      unlimited.push(key);
    }
    expect(checked).toBeGreaterThan(20);
    expect(unlimited).toEqual([]);
  });

  it('keeps the unlimited list honest: each entry is a real, unauthenticated route', () => {
    for (const key of Object.keys(UNLIMITED_PUBLIC)) {
      const route = routes.find((r) => `${r.method} ${r.path}` === key);
      expect(route, key).toBeDefined();
      expect(chainFor(route!).includes(authenticate), key).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------------ */
/* 3. IDOR: another gym's ids answer 404 on every :id route                  */
/* ------------------------------------------------------------------------ */

type Table = SQLiteTable;

/** Which table a path parameter names, by route prefix (first match wins). */
const PARAM_TABLES: Array<[RegExp, string, Table]> = [
  [/\/billing\/credit-packs\/:packId/, 'packId', schema.creditPacks],
  [/\/billing\/products\/:productId/, 'productId', schema.products],
  [/\/member\/billing\/plans\/:productId/, 'productId', schema.products],
  [/\/store\/products\/:productId/, 'productId', schema.retailProducts],
  [/\/facility\/(facility-)?tasks\/:taskId/, 'taskId', schema.facilityTasks],
  [/\/admin\/tasks\/:taskId/, 'taskId', schema.tasks],
  [/\/privacy\/holds\/:id/, 'id', schema.legalHolds],
  [/\/privacy\/requests\/:id/, 'id', schema.privacyRequests],
  [/\/schedule\/booking\/:id/, 'id', schema.bookings],
  [/\/schedule\/series\/:id/, 'id', schema.classSeries],
  [/\/schedule\/session\/:id/, 'id', schema.classSessions],
  [/\/schedule\/waitlist\/:id/, 'id', schema.waitlistEntries],
  [/\/staff\/unavailability\/:id/, 'id', schema.staffUnavailability],
  [/\/files\/:id/, 'id', schema.mediaObjects],
  [/\/me\/sessions\/:id/, 'id', schema.sessions],
  [/\/engagement\/challenge\/:id/, 'id', schema.challenges],
  [/\/engagement\/feed\/:id/, 'id', schema.posts],
  [/\/progress\/goals\/:id/, 'id', schema.goals],
  [/\/progress\/photos\/:id/, 'id', schema.progressPhotos],
  [/\/training\/adaptive\/:id/, 'id', schema.adaptiveDecisions],
  [/./, 'automationId', schema.automations],
  [/./, 'invoiceId', schema.invoices],
  [/./, 'memberId', schema.members],
  [/./, 'paymentId', schema.payments],
  [/./, 'exceptionId', schema.paymentReconciliationExceptions],
  [/./, 'broadcastId', schema.broadcasts],
  [/./, 'checkInId', schema.weeklyCheckIns],
  [/./, 'postId', schema.posts],
  [/./, 'targetId', schema.posts],
  [/./, 'challengeId', schema.challenges],
  [/./, 'equipmentId', schema.equipment],
  [/./, 'workOrderId', schema.workOrders],
  [/./, 'conversationId', schema.conversations],
  [/./, 'endpointId', schema.webhookEndpoints],
  [/./, 'deliveryId', schema.webhookDeliveries],
  [/./, 'leadId', schema.leads],
  [/./, 'staffId', schema.staff],
  [/./, 'branchId', schema.branches],
  [/./, 'roomId', schema.rooms],
  [/./, 'lineId', schema.commissionLines],
  [/./, 'shiftId', schema.shifts],
  [/./, 'orderId', schema.posOrders],
  [/./, 'transferId', schema.stockTransfers],
  [/./, 'interventionId', schema.interventions],
  [/./, 'ticketId', schema.tickets],
  [/./, 'assignmentId', schema.assignments],
  [/./, 'dayId', schema.programDays],
  [/./, 'itemId', schema.programItems],
  [/./, 'exerciseId', schema.exercises],
  [/./, 'programId', schema.programs],
  [/./, 'attachmentId', schema.messageAttachments],
  [/./, 'subscriptionId', schema.pushSubscriptions],
  [/./, 'intentId', schema.paymentIntents],
  [/./, 'assetId', schema.mediaAssets],
  [/./, 'commentId', schema.comments],
];

/** Parameters that are not record ids of this gym, with the reason. */
const NON_ID_PARAMS: Record<string, (route: RouteInfo) => string> = {
  tenantSlug: () => 'reef', // the public website addresses a gym by slug; not an id route
  targetType: () => 'post',
  barcode: () => '', // filled from a Shark retail product below
  clientId: () => '', // filled from a Shark workout below
};

/** Mounts outside this property, with the reason. */
const IDOR_OUT_OF_SCOPE: Array<[RegExp, string]> = [
  [/^\/v1\/platform\//, 'platform operators read across gyms by design; platformOnly refuses every gym role (phase13-platform tests)'],
  [/^\/v1\/public\//, 'the public website addresses a gym by slug, not a record id'],
];

const fixtures: Array<{ table: Table; id: string }> = [];

function columnsOf(table: Table): SQLiteColumn[] {
  return getTableConfig(table).columns as SQLiteColumn[];
}

function columnByName(table: Table, name: string): SQLiteColumn | undefined {
  return columnsOf(table).find((column) => column.name === name);
}

/** A row of `table` that belongs to the Shark gym (or, for a table without a
 *  tenant column, any row), creating a minimal one when the seed has none. */
function sharkRowId(table: Table, depth = 0): string {
  const tenantColumn = columnByName(table, 'tenant_id');
  const idColumn = columnByName(table, 'id')!;
  // A live row: a soft-deleted one answers 404 for reasons other than tenancy.
  const deletedColumn = columnByName(table, 'deleted_at');
  const where = and(tenantColumn ? eq(tenantColumn, SHARK) : undefined, deletedColumn ? isNull(deletedColumn) : undefined);
  const found = db.select({ id: idColumn }).from(table).where(where).limit(1).get() as { id: string } | undefined;
  if (found) return found.id;
  if (depth > 4) throw new Error(`Could not build a Shark row for ${getTableConfig(table).name}`);
  return insertMinimal(table, depth);
}

/**
 * Inserts the smallest valid row: every NOT NULL column without a default gets
 * a value of its type, foreign keys point at Shark rows (built the same way
 * when the seed has none), enums take their first value. Removed afterwards.
 */
function insertMinimal(table: Table, depth: number): string {
  const config = getTableConfig(table);
  const references = new Map<string, Table>();
  for (const fk of config.foreignKeys) {
    const ref = fk.reference();
    ref.columns.forEach((column) => references.set(column.name, ref.foreignTable));
  }
  const rowId = newId('p09');
  const values: Record<string, unknown> = {};
  for (const column of config.columns as SQLiteColumn[]) {
    const key = Object.entries(table as unknown as Record<string, unknown>).find(([, value]) => value === column)?.[0];
    if (!key) continue;
    if (column.name === 'id') {
      values[key] = rowId;
      continue;
    }
    if (column.name === 'tenant_id') {
      values[key] = SHARK;
      continue;
    }
    const referenced = references.get(column.name);
    if (referenced && (column.notNull || column.name.endsWith('member_id'))) {
      values[key] = referenced === table ? null : sharkRowId(referenced, depth + 1);
      continue;
    }
    if (!column.notNull || column.hasDefault) continue;
    values[key] = sampleColumn(column);
  }
  db.insert(table).values(values as never).run();
  fixtures.push({ table, id: rowId });
  return rowId;
}

function sampleColumn(column: SQLiteColumn): unknown {
  const enumValues = (column as unknown as { enumValues?: string[] }).enumValues;
  if (enumValues?.length) return enumValues[0];
  switch (column.columnType) {
    case 'SQLiteInteger':
    case 'SQLiteReal':
    case 'SQLiteNumeric':
      return column.name.endsWith('_at') ? now() : 1;
    case 'SQLiteTimestamp':
      return new Date();
    case 'SQLiteBoolean':
      return false;
    case 'SQLiteTextJson':
    case 'SQLiteBlobJson':
      return column.name.endsWith('s') ? [] : {};
    default:
      if (column.name.endsWith('_on') || column.name.endsWith('date')) return '2026-11-26';
      return `p09-${column.name}-${newId('v').slice(-6)}`;
  }
}

function tableFor(route: RouteInfo, param: string): Table | undefined {
  return PARAM_TABLES.find(([pattern, name]) => name === param && pattern.test(route.path))?.[2];
}

function sharkIdFor(route: RouteInfo, param: string): string {
  if (param === 'barcode') {
    const product = db.select({ barcode: schema.retailProducts.barcode }).from(schema.retailProducts)
      .where(and(eq(schema.retailProducts.tenantId, SHARK), isNotNull(schema.retailProducts.barcode))).get();
    return product!.barcode!;
  }
  if (param === 'clientId') {
    return db.select({ clientId: schema.workouts.clientId }).from(schema.workouts).where(and(eq(schema.workouts.tenantId, SHARK), isNotNull(schema.workouts.clientId))).get()!.clientId!;
  }
  if (param in NON_ID_PARAMS) return NON_ID_PARAMS[param]!(route);
  if (param === 'exerciseId') {
    // The shared exercise library has no tenant; only a gym's own exercise is private to it.
    const own = db.select({ id: schema.exercises.id }).from(schema.exercises).where(eq(schema.exercises.tenantId, SHARK)).get();
    return own?.id ?? insertMinimal(schema.exercises, 0);
  }
  if (param === 'id' && /\/me\/sessions\//.test(route.path)) {
    const session = db.select({ id: schema.sessions.id }).from(schema.sessions)
      .where(and(eq(schema.sessions.tenantId, SHARK), isNull(schema.sessions.revokedAt))).get();
    return session!.id;
  }
  const table = tableFor(route, param);
  if (!table) throw new Error(`No table mapped for :${param} in ${route.method} ${route.path}`);
  return sharkRowId(table);
}

/** Body and query ids belong to the *caller's* gym (Reef), so the only
 *  foreign thing in the request is the id in the path. */
function bodyIdFor(key: string): string | undefined {
  if (key === 'branchId' || key === 'fromBranchId') return 'brn_reef_main';
  // An end after its start, so a handler's own range check passes too.
  if (/^(endsAt|endAt|until)$/.test(key)) return '2026-11-26T10:00:00.000Z';
  return undefined;
}

/**
 * Fields a schema leaves optional but a handler insists on before it loads
 * anything (a moderation reason, the owner's password for an identity fix).
 * Supplied truthfully so the request reaches the record lookup.
 */
const HANDLER_REQUIRED: Record<string, unknown> = { reason: 'P09 isolation probe', currentPassword: 'shark1234' };

function withHandlerChecks(schema: ZodTypeAny, body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  const extended = { ...(body as Record<string, unknown>) };
  for (const [key, value] of Object.entries(HANDLER_REQUIRED)) {
    if (schema.safeParse({ ...extended, [key]: value }).success) extended[key] = value;
  }
  return extended;
}

/** Retired endpoints that refuse every call before reading anything. */
const ALWAYS_REFUSED: Record<string, string> = {
  'POST /v1/member/billing/checkout-intent/:intentId/confirm':
    'retired pre-Razorpay endpoint: answers 412 to every caller before any lookup (routes/member/billing.ts receptionSettlement)',
};

/** A signed link is needed to reach the file routes at all. Sign one for the
 *  Reef caller, as if a Shark link had leaked to them: still 404. */
function signedQuery(route: RouteInfo, path: string, userId: string): string | undefined {
  if (route.path === '/v1/files/:id') return signMediaUrl(decodeURIComponent(path.split('/').pop()!), userId).url.split('?')[1];
  if (route.path === '/v1/attachments/:attachmentId') return signMediaPath(attachmentPath(decodeURIComponent(path.split('/').pop()!)), now()).split('?')[1];
  return undefined;
}

let reefOwner: TestSession;
let reefOwnerUserId: string;
let reefMember: TestSession;
let reefMemberUserId: string;
let razorpay: Harness;

describe('[P09-SEC-IDOR] every :id route answers 404 to another gym', () => {
  const idRoutes = routes.filter((route) => paramsOf(route.path).length > 0 && !IDOR_OUT_OF_SCOPE.some(([pattern]) => pattern.test(route.path)));

  beforeAll(async () => {
    // Online payment configured (a local fake), so checkout routes get as far
    // as loading the invoice/plan/intent instead of answering 412 for all.
    razorpay = await startHarness();
    reefOwner = await signIn('owner@reefathletic.in', 'reef', true);
    reefOwnerUserId = db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, 'owner@reefathletic.in')).get()!.id;
    // A Reef member who can sign in (the seed gives Reef members no account).
    const member = db.select().from(schema.members).where(and(eq(schema.members.tenantId, 'ten_reef'), isNull(schema.members.userId))).get()!;
    reefMemberUserId = newId('usr');
    db.insert(schema.users).values({
      id: reefMemberUserId,
      tenantId: 'ten_reef',
      email: `p09-idor-${reefMemberUserId.slice(-6)}@reefathletic.in`,
      phone: null,
      name: `${member.firstName} ${member.lastName}`,
      initials: member.initials,
      role: 'member',
      accountState: 'active',
      passwordHash: hashPassword('shark1234'),
      preferences: { register: 'plain', theme: 'dark', unitSystem: 'metric', haptics: false },
      lastSeenAt: null,
      createdAt: now(),
      updatedAt: now(),
    }).run();
    db.update(schema.members).set({ userId: reefMemberUserId }).where(eq(schema.members.id, member.id)).run();
    const email = db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, reefMemberUserId)).get()!.email!;
    reefMember = await signIn(email, 'reef', true);
    // A Shark session exists to point /me/sessions/:id at.
    await signIn('rohit@sharkfitness.in', 'shark', true);
  });

  afterAll(async () => {
    await razorpay.close();
    db.update(schema.members).set({ userId: null }).where(eq(schema.members.userId, reefMemberUserId)).run();
    db.delete(schema.sessions).where(eq(schema.sessions.userId, reefMemberUserId)).run();
    db.delete(schema.users).where(eq(schema.users.id, reefMemberUserId)).run();
    for (const fixture of fixtures.reverse()) {
      const idColumn = columnByName(fixture.table, 'id')!;
      db.delete(fixture.table).where(eq(idColumn, fixture.id)).run();
    }
  });

  it('enumerates the id routes', () => {
    expect(idRoutes.length).toBeGreaterThan(150);
  });

  it('maps every id parameter to a table (a new parameter needs a mapping here)', () => {
    const unmapped = idRoutes.flatMap((route) =>
      paramsOf(route.path)
        .filter((param) => !(param in NON_ID_PARAMS) && param !== 'exerciseId' && !tableFor(route, param))
        .map((param) => `:${param} in ${route.method} ${route.path}`),
    );
    expect(unmapped).toEqual([]);
  });

  it('answers 404 (never the record, never 403) for this gym\'s ids', async () => {
    const leaks: string[] = [];
    for (const route of idRoutes) {
      const session = route.path.startsWith('/v1/member/') ? reefMember : reefOwner;
      const path = concretePath(route.path, (param) => sharkIdFor(route, param));
      const chain = chainFor(route);
      const query = chain.map(validatorSchemaOf).find((entry) => entry?.target === 'query');
      const json = chain.map(validatorSchemaOf).find((entry) => entry?.target === 'json');
      const signed = signedQuery(route, path, session === reefMember ? reefMemberUserId : reefOwnerUserId);
      const search = signed
        ? `?${signed}`
        : query
          ? `?${new URLSearchParams(Object.entries(sampleValid(query.schema, bodyIdFor) as Record<string, unknown>).map(([k, v]): [string, string] => [k, String(v)]))}`
          : '';
      const body = json ? withHandlerChecks(json.schema, sampleValid(json.schema, bodyIdFor)) : MUTATING_METHODS.has(route.method) ? {} : undefined;
      resetRateLimitsForTest();
      const response = await call(session, route.method, path + search, body, { 'idempotency-key': `p09-idor-${newId('k')}` });
      if (response.status === 404) continue;
      if (`${route.method} ${route.path}` in ALWAYS_REFUSED && response.status === 412) continue;
      const payload = await response.json().catch(() => null);
      const error = (payload as { error?: { message?: string } } | null)?.error;
      leaks.push(`${route.method} ${route.path} → ${response.status} ${codeOf(payload) ?? ''} ${error?.message ?? ''}`);
    }
    expect(leaks).toEqual([]);
  });
});
