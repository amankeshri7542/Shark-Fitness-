/* ============================================================================
   Builds a Postman collection that calls every route of the Shark Fitness API,
   as every role, against a running server: local or hosted.

   It signs each demo account in once, looks up the ids it needs through the
   API itself, and writes out/collection.json and out/env.json for the Postman
   CLI. run.mjs does that and runs it. The target must hold the demo seed: the
   accounts, branch ids and plans named here are the seed's.

   out/env.json holds live session tokens for the demo accounts. git ignores
   it; do not share it.

   usage: node scripts/postman/generate.mjs --base-url <url> [--read-only]
   ========================================================================= */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, '../..');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/* The demo seed's accounts. They all share the seed's password. */
const ROLES = {
  owner: { slug: 'shark', email: 'owner@sharkfitness.in' },
  manager: { slug: 'shark', email: 'manager@sharkfitness.in' },
  reception: { slug: 'shark', email: 'reception@sharkfitness.in' },
  trainer: { slug: 'shark', email: 'rehan@sharkfitness.in' },
  accountant: { slug: 'shark', email: 'accounts@sharkfitness.in' },
  member: { slug: 'shark', email: 'aman@sharkfitness.in' },
  member2: { slug: 'shark', email: 'rohit@sharkfitness.in' },
  platform: { slug: 'platform', email: 'platform@sharkfitness.io' },
  reef: { slug: 'reef', email: 'owner@reefathletic.in' },
};

/* Query strings a GET needs to be answerable at all. */
const QUERY = {
  '/v1/admin/reports/revenue': 'from={{from}}&to={{to}}',
  '/v1/admin/reports/membership': 'from={{from}}&to={{to}}',
  '/v1/admin/reports/attendance': 'from={{from}}&to={{to}}',
  '/v1/admin/reports/trainer': 'from={{from}}&to={{to}}',
  '/v1/admin/reports/retention': 'from={{from}}&to={{to}}',
  '/v1/admin/attendance/search': 'q=Aman',
  '/v1/admin/members': 'q=&limit=20',
  '/v1/admin/training/exercises': 'archived=false',
  '/v1/admin/schedule/clashes': 'branchId=br_kor&startsAt={{tomorrowNoonIso}}&endsAt={{tomorrowOnePmIso}}',
  '/v1/admin/staff/commission': 'periodStart={{from}}&periodEnd={{to}}',
};
/* Routes whose :id the seed has no row for: 404 is the right answer. */
const ABSENT = new Set(['/v1/admin/privacy/requests/:id', '/v1/admin/privacy/requests/:id/export']);
/* Routes that act on a record without needing a body. In the empty-body sweep
   they are sent an id that does not exist, so a run cannot retire the plan the
   next run sells, cancel a member's class or run an automation on the demo it
   is checking. The journeys cover what they really do. */
const ACTS_WITHOUT_BODY = new Set([
  'DELETE /v1/member/schedule/booking/:id',
  'DELETE /v1/member/engagement/challenge/:id/leave',
  'POST /v1/admin/billing/products/:productId/retire',
  'POST /v1/admin/billing/products/:productId/duplicate',
  'POST /v1/admin/schedule/booking/:id/release',
  'POST /v1/admin/training/programs/:programId/version',
  'POST /v1/admin/automations/:automationId/run',
]);
/* The check-in refusals that only mean "not at this hour". */
const CLOSED_DECISIONS = ['denied_outside_hours', 'denied_branch_closed'];

export function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'base-url': { type: 'string' },
      out: { type: 'string', default: join(here, 'out') },
      password: { type: 'string', default: process.env.SHARK_DEMO_PASSWORD ?? 'shark1234' },
      'read-only': { type: 'boolean', default: false },
    },
  });
  if (!values['base-url']) throw new Error('Pass the server to check: --base-url https://your-app.example.com');
  const baseUrl = new URL(values['base-url']).origin;
  return { baseUrl, outDir: resolve(values.out), password: values.password, readOnly: values['read-only'] };
}

/** The API's routes, read from source so the collection never misses one. */
function readRoutes() {
  const result = spawnSync(join(repository, 'apps/api/node_modules/.bin/tsx'), [join(here, 'list-routes.ts')], {
    cwd: join(repository, 'apps/api'),
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'development', SHARK_DB: join(mkdtempSync(join(tmpdir(), 'shark-routes-')), 'routes.db') },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not list the API's routes. Run pnpm install first.\n${result.error?.message ?? result.stderr}`);
  }
  return result.stdout.trim().split('\n').map((line) => {
    const [method, path] = line.split(' ');
    return { method, path };
  });
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Sign-in allows ten attempts a minute from one address, so a rerun waits. */
async function signIn(baseUrl, password, role, { slug, email }) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`${baseUrl}/v1/auth/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ tenantSlug: slug, email, password }),
    });
    const text = await response.text();
    if (response.status === 429 && attempt < 4) {
      const wait = JSON.parse(text).error?.retryAfterSec ?? 60;
      console.log(`  sign-in limit reached; waiting ${wait}s`);
      await sleep((wait + 1) * 1000);
      continue;
    }
    if (response.status !== 200) throw new Error(`Signing in as ${role} (${email}) failed with ${response.status}: ${text.slice(0, 300)}`);
    const session = response.headers.getSetCookie().map((cookie) => /^shark_session=([^;]+)/.exec(cookie)?.[1]).find(Boolean);
    if (!session) throw new Error(`Signing in as ${role} set no shark_session cookie.`);
    return { session, csrf: JSON.parse(text).csrfToken };
  }
}

export async function generate({ baseUrl, outDir, password, readOnly }) {
  const routes = readRoutes();
  console.log(`${routes.length} routes. Signing in ${Object.keys(ROLES).length} demo accounts at ${baseUrl}`);
  const sessions = {};
  for (const [role, account] of Object.entries(ROLES)) sessions[role] = await signIn(baseUrl, password, role, account);

  const get = async (role, path) => {
    const { session, csrf } = sessions[role];
    const response = await fetch(`${baseUrl}${path}`, { headers: { origin: baseUrl, cookie: `shark_session=${session}; shark_csrf=${csrf}` } });
    const text = await response.text();
    if (!response.ok) throw new Error(`${role} GET ${path} answered ${response.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  };
  /* A lookup that finds nothing leaves its routes expecting 404, not a crash. */
  const missing = [];
  const look = async (name, find) => {
    try {
      const value = await find();
      if (value === undefined || value === null) missing.push(name);
      return value ?? null;
    } catch (error) {
      missing.push(`${name} (${error.message})`);
      return null;
    }
  };

  /* ——— Ids, looked up through the API ——— */
  console.log('Looking up ids');
  const business = await get('owner', '/v1/admin/settings/business');
  const localDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: business.timezone }).format(ms);
  const now = Date.now();
  const days = Array.from({ length: 7 }, (_, i) => localDate(now + i * DAY));
  const tenantId = (await get('owner', '/v1/me')).viewer.tenantId;
  const aman = (await get('member', '/v1/me')).viewer.memberId;
  const rohit = (await get('member2', '/v1/me')).viewer.memberId;
  const members = (await get('owner', '/v1/admin/members?q=&limit=100')).items;
  const sortedInvoices = (billing) => [...billing.invoices].sort((a, b) => a.issuedOn.localeCompare(b.issuedOn));
  const amanBilling = await look('member billing', () => get('member', '/v1/member/billing'));
  const plan = await look('training plan', () => get('member', '/v1/member/training/plan'));
  const adminSessions = await look('admin schedule', async () =>
    (await Promise.all(days.map((date) => get('owner', `/v1/admin/schedule?date=${date}`)))).flatMap((day) => day.items),
  );
  const upcomingKor = (adminSessions ?? []).filter((s) => s.branchId === 'br_kor' && s.state === 'scheduled' && Date.parse(s.startsAt) > now);
  const program = await look('program', async () => {
    const first = (await get('owner', '/v1/admin/training/programs')).items[0];
    return first ? get('owner', `/v1/admin/training/programs/${first.id}`) : null;
  });

  const ids = {
    otherMember: await look('otherMember', () => members.find((m) => m.id !== aman && m.id !== rohit)?.id),
    expiredMember: await look('expiredMember', () => members.find((m) => m.membershipState === 'expired')?.id),
    leadId: await look('leadId', async () =>
      (await get('owner', '/v1/admin/leads')).items.find((l) => l.branchId === 'br_kor' && !['won', 'lost'].includes(l.stage))?.id,
    ),
    amanInvoice: await look('amanInvoice', () => sortedInvoices(amanBilling)[0]?.id),
    rohitInvoice: await look('rohitInvoice', async () => sortedInvoices(await get('member2', '/v1/member/billing'))[0]?.id),
    amanPayment: await look('amanPayment', () => amanBilling.receipts[0]?.id),
    conversationId: await look('conversationId', async () =>
      (await get('member', '/v1/member/messages')).items.find((c) => c.kind === 'coach' && c.state === 'open')?.id,
    ),
    benchId: await look('benchId', async () =>
      (await get('owner', '/v1/admin/training/exercises?archived=false')).items.find((e) => e.slug === 'barbell-bench-press')?.id,
    ),
    workoutClientId: await look('workoutClientId', () => plan.week.days.find((d) => d.completed)?.completed.clientId),
    adaptiveId: await look('adaptiveId', () => plan.adaptive?.id),
    assignmentId: await look('assignmentId', () => plan.assignment?.id),
    challengeId: await look('challengeId', async () => (await get('member', '/v1/member/engagement')).challenges[0]?.id),
    postId: await look('postId', async () => (await get('member', '/v1/member/engagement/feed')).items[0]?.id),
    amanBookingId: await look('amanBookingId', async () => (await get('member', '/v1/member/home')).nextBooking?.bookingId),
    goalId: await look('goalId', async () => (await get('member', '/v1/member/progress')).goals[0]?.id),
    amanHabitId: await look('amanHabitId', async () => (await get('member', '/v1/member/habits')).habits.find((h) => h.active)?.id),
    assetId: await look('assetId', async () => (await get('member', '/v1/member/media')).items[0]?.id),
    sessionId: await look('sessionId', () => upcomingKor[0]?.id),
    seriesId: await look('seriesId', async () => (await get('owner', '/v1/admin/schedule/series')).series[0]?.id),
    adminBookingId: await look('adminBookingId', async () => {
      for (const session of upcomingKor.slice(0, 10)) {
        const booking = (await get('owner', `/v1/admin/schedule/session/${session.id}`)).roster.find((r) => r.state === 'confirmed');
        if (booking) return booking.bookingId;
      }
      return null;
    }),
    staffId: await look('staffId', async () => (await get('owner', '/v1/admin/staff')).items.find((s) => s.email === ROLES.trainer.email)?.id),
    retailProduct: await look('retailProduct', async () => (await get('owner', '/v1/admin/store/products')).items.find((p) => p.active && p.barcode)),
    orderId: await look('orderId', async () => (await get('owner', '/v1/admin/store/orders')).items.find((o) => o.branchId === 'br_kor')?.id),
    transferId: await look('transferId', async () => (await get('owner', '/v1/admin/store/transfers')).items[0]?.id),
    equipmentId: await look('equipmentId', async () => (await get('owner', '/v1/admin/facility/equipment')).items.find((x) => x.branchId === 'br_kor')?.id),
    workOrderId: await look('workOrderId', async () => (await get('owner', '/v1/admin/facility/work-orders')).items.find((x) => x.branchId === 'br_kor')?.id),
    taskId: await look('taskId', async () => (await get('owner', '/v1/admin/facility/tasks')).items.find((x) => x.branchId === 'br_kor')?.id),
    roomId: await look('roomId', async () => (await get('owner', '/v1/admin/settings/branches/br_kor')).branch.rooms[0]?.id),
    ticketId: await look('ticketId', async () => (await get('owner', '/v1/admin/support/tickets')).items[0]?.id),
    interventionId: await look('interventionId', async () => (await get('owner', '/v1/admin/support/retention')).interventions[0]?.id),
    automationId: await look('automationId', async () => (await get('owner', '/v1/admin/automations')).items[0]?.id),
    programId: await look('programId', () => program?.program.id),
    dayId: await look('dayId', () => program?.days[0]?.id),
    itemId: await look('itemId', () => program?.days.flatMap((d) => d.items)[0]?.id),
    // An invoice the Koramangala manager cannot see: another branch's.
    otherBranchInvoice: await look('otherBranchInvoice', async () => {
      const managerSees = new Set((await get('manager', '/v1/admin/billing/invoices')).items.map((i) => i.id));
      return (await get('owner', '/v1/admin/billing/invoices')).items.find((i) => !managerSees.has(i.id))?.id;
    }),
    // A future class at Koramangala the member may book free of charge: the
    // server's own eligibility already rules out a clash with their bookings.
    memberSessionId: await look('memberSessionId', async () =>
      (await Promise.all(days.map((date) => get('member', `/v1/member/schedule?branchId=br_kor&date=${date}`))))
        .flatMap((day) => day.items)
        .find((s) => s.state === 'scheduled' && s.eligibility?.canBook && s.eligibility.creditsRequired === 0 && Date.parse(s.startsAt) > now + 6 * HOUR)?.id,
    ),
  };
  ids.deskSessionId = await look('deskSessionId', () => {
    const open = upcomingKor.filter((s) => s.creditsRequired === 0 && s.seatsLeft > 0 && Date.parse(s.startsAt) > now + 6 * HOUR && s.id !== ids.memberSessionId);
    return (open[6] ?? open.at(-1))?.id;
  });
  const monthly = await look('Depot Monthly', async () => {
    const body = await get('owner', '/v1/admin/billing/products');
    return (body.items ?? body.products).find((p) => p.id === 'prd_monthly');
  });
  const servesApps = await fetch(`${baseUrl}/`).then((r) => (r.headers.get('content-type') ?? '').includes('text/html')).catch(() => false);

  /* What the journey's invoice must say, from the gym's own settings. */
  const tax = business.taxProfile;
  const gstin = business.currency === 'INR' && tax?.label === 'GST' ? tax.registrationNumber : '';
  const money = (minor) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(minor / 100);
  const percent = (bp) => `${Number((bp / 100).toFixed(2))}%`;
  const monthlyTax = monthly ? Math.round((monthly.priceMinor * monthly.taxRateBp) / 10_000) : 0;
  const monthlyTotal = monthly ? monthly.priceMinor + monthlyTax : 0;
  const retail = ids.retailProduct;
  const retailTotal = retail ? retail.priceMinor + Math.round((retail.priceMinor * retail.taxRateBp) / 10_000) : 0;

  /* ——— Path parameters ——— */
  const param = (name, path) => {
    switch (name) {
      case 'branchId': return 'br_kor';
      case 'exerciseId': return path.includes('/admin/training/exercises') ? 'exr_unknown' : ids.benchId;
      case 'clientId': return ids.workoutClientId;
      case 'conversationId': return ids.conversationId;
      case 'invoiceId': return ids.amanInvoice;
      case 'paymentId': return ids.amanPayment;
      case 'intentId': return 'pi_unknown';
      case 'assetId': return ids.assetId;
      case 'memberId':
        if (path.includes('/engagement/block/') || path.includes('/challenges/')) return ids.otherMember;
        if (path.includes('/renewal-quote') || path.includes('/renew')) return ids.expiredMember;
        return aman;
      case 'leadId': return ids.leadId;
      case 'staffId': return ids.staffId;
      case 'shiftId': return 'shf_unknown';
      case 'lineId': return 'cml_unknown';
      case 'productId': return path.includes('/store/') ? retail?.id : 'prd_monthly';
      case 'barcode': return retail?.barcode;
      case 'orderId': return ids.orderId;
      case 'transferId': return ids.transferId;
      case 'equipmentId': return ids.equipmentId;
      case 'workOrderId': return ids.workOrderId;
      case 'taskId': return ids.taskId;
      case 'roomId': return ids.roomId;
      case 'ticketId': return ids.ticketId;
      case 'interventionId': return ids.interventionId;
      case 'automationId': return ids.automationId;
      case 'challengeId': return ids.challengeId;
      case 'tenantId': return tenantId;
      case 'programId': return ids.programId;
      case 'dayId': return ids.dayId;
      case 'itemId': return ids.itemId;
      case 'assignmentId': return ids.assignmentId;
      case 'id':
        if (path.startsWith('/v1/member/engagement/challenge')) return ids.challengeId;
        if (path.startsWith('/v1/member/engagement/feed')) return ids.postId;
        if (path.startsWith('/v1/member/schedule/booking')) return ids.amanBookingId;
        if (path.startsWith('/v1/member/schedule/waitlist')) return 'wtl_unknown';
        if (path.startsWith('/v1/member/training/adaptive')) return ids.adaptiveId;
        if (path.startsWith('/v1/member/progress/goals')) return ids.goalId;
        if (path.startsWith('/v1/admin/schedule/session')) return ids.sessionId;
        if (path.startsWith('/v1/admin/schedule/series')) return ids.seriesId;
        if (path.startsWith('/v1/admin/schedule/booking')) return ids.adminBookingId;
        if (path.startsWith('/v1/me/sessions')) return 'ses_unknown';
        return 'unknown_id';
      default: return `unknown_${name}`;
    }
  };
  /** The concrete path, and whether it names a row the seed lacks. */
  const fill = (path) => {
    let absent = ABSENT.has(path);
    const filled = path.replace(/:([A-Za-z]+)/g, (_m, name) => {
      const value = param(name, path);
      if (value === null || value === undefined) absent = true;
      return value ?? `unknown_${name}`;
    });
    return { filled, absent };
  };

  /* ——— Requests ——— */
  const headersFor = (role, { json = false, csrf = true, origin = '{{baseUrl}}' } = {}) => {
    const header = [{ key: 'Origin', value: origin }];
    if (role) {
      header.push({ key: 'Cookie', value: `shark_session={{${role}_session}}; shark_csrf={{${role}_csrf}}` });
      if (csrf) header.push({ key: 'x-csrf-token', value: `{{${role}_csrf}}` });
    }
    if (json) header.push({ key: 'Content-Type', value: 'application/json' });
    return header;
  };
  const expectStatus = (allowed) => [
    `pm.test('no server error', function () { pm.expect(pm.response.code, pm.response.text().slice(0, 400)).to.be.below(500); });`,
    ...(allowed ? [`pm.test('status is one of ${allowed.join('/')}', function () { pm.expect(${JSON.stringify(allowed)}, 'got ' + pm.response.code + ': ' + pm.response.text().slice(0, 300)).to.include(pm.response.code); });`] : []),
  ];
  let counter = 0;
  const request = (name, method, path, { role, body, query, allowed, extraTests = [], pre, headers, idempotencyKey } = {}) => {
    const header = headers ?? headersFor(role, { json: body !== undefined });
    if (idempotencyKey) header.push({ key: 'Idempotency-Key', value: idempotencyKey });
    return {
      id: `r${String(++counter).padStart(4, '0')}`,
      name,
      request: {
        method,
        header,
        url: `{{baseUrl}}${path}${query ? `?${query}` : ''}`,
        ...(body !== undefined ? { body: { mode: 'raw', raw: typeof body === 'string' ? body : JSON.stringify(body, null, 2), options: { raw: { language: 'json' } } } } : {}),
      },
      event: [
        ...(pre ? [{ listen: 'prerequest', script: { type: 'text/javascript', exec: pre } }] : []),
        { listen: 'test', script: { type: 'text/javascript', exec: [...expectStatus(allowed), ...extraTests] } },
      ],
      protocolProfileBehavior: { disableCookies: true },
    };
  };
  /* A journey step whose ids the target lacks is left out and reported. */
  const skipped = [];
  const needing = (names, label, make) => {
    const lacking = names.filter((name) => ids[name] === null || ids[name] === undefined);
    if (lacking.length === 0) return [make(label)];
    skipped.push(`${label} (no ${lacking.join(', ')})`);
    return [];
  };

  /* ——— 0. Every session works ——— */
  const sessionChecks = Object.entries(ROLES).map(([role, { email }]) =>
    request(`${role} session is signed in`, 'GET', '/v1/auth/session', {
      role,
      allowed: [200],
      extraTests: [`pm.test('as ${email}', function () { pm.expect(pm.response.json().viewer.email).to.eql('${email}'); });`],
    }),
  );

  /* ——— 1. Public, transport and security ——— */
  const security = [
    request('health', 'GET', '/health', { allowed: [200] }),
    request('ready reports database, schema and configuration', 'GET', '/ready', {
      allowed: [200],
      extraTests: [`pm.test('ready', function () { const b = pm.response.json(); pm.expect(b.database).to.eql('ready'); pm.expect(b.schema).to.eql('ready'); pm.expect(b.configuration).to.eql('ready'); });`],
    }),
    ...(servesApps
      ? [
          request('member app shell', 'GET', '/', { allowed: [200], extraTests: [`pm.test('html', function () { pm.expect(pm.response.headers.get('content-type')).to.include('text/html'); });`] }),
          request('admin app shell', 'GET', '/admin/', { allowed: [200], extraTests: [`pm.test('admin title', function () { pm.expect(pm.response.text()).to.include('Operations'); });`] }),
        ]
      : []),
    request('unknown API path is a JSON 404, not the app shell', 'GET', '/v1/does-not-exist', { role: 'owner', allowed: [404] }),
    request('anonymous admin read is refused', 'GET', '/v1/admin/members', { allowed: [401] }),
    request('anonymous member read is refused', 'GET', '/v1/member/home', { allowed: [401] }),
    request('a write without the CSRF token is refused', 'POST', '/v1/admin/leads', {
      headers: headersFor('owner', { json: true, csrf: false }),
      body: { name: 'No CSRF', phone: '+91 9800000001', source: 'walk_in', branchId: 'br_kor' },
      allowed: [403],
    }),
    request('a write from a foreign origin is refused', 'POST', '/v1/admin/leads', {
      headers: headersFor('owner', { json: true, origin: 'https://evil.example' }),
      body: { name: 'Foreign', phone: '+91 9800000002', source: 'walk_in', branchId: 'br_kor' },
      allowed: [403],
    }),
    request('a member cannot read the console', 'GET', '/v1/admin/dashboard', { role: 'member', allowed: [403] }),
    request('a gym owner cannot reach platform administration', 'GET', '/v1/platform/tenants', { role: 'owner', allowed: [403] }),
    request('another gym cannot read this gym’s member', 'GET', `/v1/admin/members/${aman}`, { role: 'reef', allowed: [404] }),
    ...needing(['amanInvoice'], 'another gym cannot read this gym’s invoice', (label) => request(label, 'GET', `/v1/admin/billing/invoices/${ids.amanInvoice}`, { role: 'reef', allowed: [404] })),
    ...needing(['otherBranchInvoice'], 'a manager cannot read another branch’s invoice', (label) => request(label, 'GET', `/v1/admin/billing/invoices/${ids.otherBranchInvoice}`, { role: 'manager', allowed: [404] })),
    ...needing(['rohitInvoice'], 'a member cannot read another member’s tax invoice', (label) => request(label, 'GET', `/v1/member/billing/invoices/${ids.rohitInvoice}/tax-invoice`, { role: 'member', allowed: [404] })),
  ];

  /* ——— 2. Every GET route, for every role it concerns ——— */
  const SKIP_GET = new Set(['/health', '/ready', '/v1/auth/tenants', '/v1/auth/csrf', '/v1/auth/session']);
  const getSweep = [];
  for (const { method, path } of routes) {
    if (method !== 'GET' || SKIP_GET.has(path)) continue;
    const { filled, absent } = fill(path);
    const query = QUERY[path];
    const own = (allowed) => (absent ? [404] : allowed);
    if (path.startsWith('/v1/admin/')) {
      getSweep.push(request(`owner GET ${path}`, 'GET', filled, { role: 'owner', query, allowed: own([200]) }));
      for (const role of ['manager', 'reception', 'trainer', 'accountant']) {
        getSweep.push(request(`${role} GET ${path}`, 'GET', filled, { role, query, allowed: [200, 403, 404, 422] }));
      }
      getSweep.push(request(`member GET ${path}`, 'GET', filled, { role: 'member', query, allowed: [403] }));
      getSweep.push(request(`reef GET ${path}`, 'GET', filled, { role: 'reef', query, allowed: path.includes(':') ? [403, 404] : [200, 403, 404, 422] }));
    } else if (path.startsWith('/v1/member/')) {
      getSweep.push(request(`member GET ${path}`, 'GET', filled, { role: 'member', query, allowed: own([200]) }));
      getSweep.push(request(`member2 GET ${path}`, 'GET', filled, { role: 'member2', query, allowed: [200, 403, 404] }));
      getSweep.push(request(`owner GET ${path}`, 'GET', filled, { role: 'owner', query, allowed: [403, 404] }));
    } else if (path.startsWith('/v1/me')) {
      for (const role of ['owner', 'member']) getSweep.push(request(`${role} GET ${path}`, 'GET', filled, { role, query, allowed: [200] }));
    } else if (path.startsWith('/v1/platform/')) {
      getSweep.push(request(`platform GET ${path}`, 'GET', filled, { role: 'platform', query, allowed: own([200]) }));
      getSweep.push(request(`owner GET ${path}`, 'GET', filled, { role: 'owner', query, allowed: [403] }));
    } else {
      getSweep.push(request(`owner GET ${path}`, 'GET', filled, { role: 'owner', query, allowed: own([200]) }));
    }
  }

  /* ——— 3. Journeys: these write ——— */
  const setVar = (name, expr) => `pm.collectionVariables.set('${name}', ${expr});`;
  const idOf = `(function (b) { return b.id || (b.ticket && b.ticket.id) || (b.lead && b.lead.id) || (b.booking && b.booking.id); })(pm.response.json())`;
  // Outside opening hours the desk refuses entry, rightly, and there is no
  // visit to repeat or close.
  const skipIfClosed = [`if (pm.collectionVariables.get('j_closed')) { console.log('S|' + pm.info.requestId); pm.execution.skipRequest(); }`];
  const workout = (label) =>
    request(label, 'POST', '/v1/member/training/workouts', {
      role: 'member',
      body: `{ "clientId": "pm-wk-{{rand}}", "assignmentId": null, "programDayId": null, "branchId": "br_kor", "title": "Postman session", "startedAt": "{{startedIso}}", "finishedAt": "{{nowIso}}", "state": "completed", "sets": [ { "clientId": "pm-set-{{rand}}", "exerciseId": "${ids.benchId}", "orderIndex": 0, "setIndex": 0, "weightKg": 60, "reps": 8, "rpe": 8, "isWarmup": false, "doneAt": "{{nowIso}}" } ], "notes": null, "sessionRpe": 7, "substitutions": [] }`,
      allowed: [200, 201],
    });
  const journeys = [
    request('reception captures a walk-in lead', 'POST', '/v1/admin/leads', {
      role: 'reception',
      body: { name: 'Postman Walk-in {{rand}}', phone: '+91 98{{rand}}', email: 'walkin{{rand}}@example.com', source: 'walk_in', branchId: 'br_kor' },
      allowed: [201], extraTests: [setVar('j_leadId', idOf)],
    }),
    request('reception converts the walk-in straight from new', 'POST', '/v1/admin/leads/{{j_leadId}}/convert', {
      role: 'reception', body: {}, allowed: [200], extraTests: [setVar('j_memberId', 'pm.response.json().memberId')],
    }),
    request('reception assigns Depot Monthly', 'POST', '/v1/admin/billing/members/{{j_memberId}}/assign-plan', {
      role: 'reception', body: { productId: 'prd_monthly' }, allowed: [201],
      extraTests: [
        setVar('j_invoiceId', 'pm.response.json().invoiceId'),
        `pm.test('not active until paid', function () { pm.expect(pm.response.json().activated).to.eql(false); });`,
      ],
    }),
    request('the desk refuses entry before payment', 'POST', '/v1/admin/attendance/check-in', {
      role: 'reception', body: { memberId: '{{j_memberId}}', branchId: 'br_kor', method: 'staff' }, allowed: [200],
      extraTests: [`pm.test('denied', function () { pm.expect(pm.response.json().granted).to.eql(false); });`],
    }),
    request(`reception reads the invoice, labelled ${gstin ? 'a tax invoice' : 'an invoice'}`, 'GET', '/v1/admin/billing/invoices/{{j_invoiceId}}', {
      role: 'reception', allowed: [200],
      extraTests: [
        setVar('j_due', 'pm.response.json().invoice.dueMinor'),
        `pm.test('${gstin ? 'Tax invoice' : 'Invoice'}', function () { pm.expect(pm.response.json().invoice.document.title).to.eql('${gstin ? 'Tax invoice' : 'Invoice'}'); });`,
        ...(monthly ? [`pm.test('${money(monthly.priceMinor)} plus ${percent(monthly.taxRateBp)} tax', function () { pm.expect(pm.response.json().invoice.dueMinor).to.eql(${monthlyTotal}); });`] : []),
      ],
    }),
    request('reception records the cash payment', 'POST', '/v1/admin/billing/invoices/{{j_invoiceId}}/payments', {
      role: 'reception', body: '{ "amountMinor": {{j_due}}, "method": "cash", "idempotencyKey": "pm-pay-{{rand}}" }', idempotencyKey: 'pm-pay-{{rand}}',
      allowed: [200], extraTests: [setVar('j_paymentId', 'pm.response.json().paymentId')],
    }),
    request('a retried payment is not taken twice', 'POST', '/v1/admin/billing/invoices/{{j_invoiceId}}/payments', {
      role: 'reception', body: '{ "amountMinor": {{j_due}}, "method": "cash", "idempotencyKey": "pm-pay-{{rand}}" }', idempotencyKey: 'pm-pay-{{rand}}',
      allowed: [200],
      extraTests: [`pm.test('same payment', function () { pm.expect(pm.response.json().paymentId).to.eql(pm.collectionVariables.get('j_paymentId')); });`],
    }),
    request('the receipt names the payment', 'GET', '/v1/admin/billing/payments/{{j_paymentId}}/receipt', {
      role: 'reception', allowed: [200],
      extraTests: [`pm.test('acknowledgement', function () { const t = pm.response.text(); pm.expect(t).to.include('PAYMENT ACKNOWLEDGEMENT'); pm.expect(t).to.include(pm.collectionVariables.get('j_paymentId')); });`],
    }),
    gstin && monthly
      ? request('the tax invoice states GSTIN, CGST and SGST', 'GET', '/v1/admin/billing/invoices/{{j_invoiceId}}/tax-invoice', {
          role: 'reception', allowed: [200],
          extraTests: [
            `pm.test('gst content', function () { const t = pm.response.text(); ${[
              'TAX INVOICE',
              `GSTIN: ${gstin}`,
              `CGST ${percent(monthly.taxRateBp / 2)} ${money(Math.floor(monthlyTax / 2))}; SGST ${percent(monthly.taxRateBp / 2)} ${money(monthlyTax - Math.floor(monthlyTax / 2))}`,
              `Invoice total: ${money(monthlyTotal)}`,
              `Balance due: ${money(0)}`,
            ].map((line) => `pm.expect(t).to.include(${JSON.stringify(line)});`).join(' ')} });`,
          ],
        })
      : request('the invoice prints', 'GET', '/v1/admin/billing/invoices/{{j_invoiceId}}/tax-invoice', { role: 'reception', allowed: [200] }),
    request('the desk lets them in once paid, if the branch is open now', 'POST', '/v1/admin/attendance/check-in', {
      role: 'reception', body: { memberId: '{{j_memberId}}', branchId: 'br_kor', method: 'staff' }, allowed: [200],
      extraTests: [
        `const b = pm.response.json();`,
        `pm.test('granted, or refused only for the hour', function () { pm.expect(b.granted || ${JSON.stringify(CLOSED_DECISIONS)}.includes(b.decision), pm.response.text()).to.eql(true); });`,
        setVar('j_closed', `b.granted ? '' : 'closed'`),
        setVar('j_checkInId', 'b.checkInId'),
      ],
    }),
    request('a second press returns the same visit', 'POST', '/v1/admin/attendance/check-in', {
      role: 'reception', body: { memberId: '{{j_memberId}}', branchId: 'br_kor', method: 'staff' }, allowed: [200], pre: skipIfClosed,
      extraTests: [`pm.test('same visit', function () { pm.expect(pm.response.json().checkInId).to.eql(pm.collectionVariables.get('j_checkInId')); });`],
    }),
    request('reception checks them out', 'POST', '/v1/admin/attendance/check-out', { role: 'reception', body: { checkInId: '{{j_checkInId}}' }, allowed: [200], pre: skipIfClosed }),
    ...needing(['deskSessionId'], 'reception books them onto a class', (label) =>
      request(label, 'POST', `/v1/admin/schedule/session/${ids.deskSessionId}/book`, {
        role: 'reception', body: { memberId: '{{j_memberId}}', idempotencyKey: 'pm-book-{{rand}}' }, allowed: [200, 201],
      }),
    ),
    ...needing(['retailProduct'], 'reception sells a shop item for cash', (label) =>
      request(label, 'POST', '/v1/admin/store/orders', {
        role: 'reception',
        body: { branchId: 'br_kor', lines: [{ productId: retail.id, quantity: 1 }], payments: [{ method: 'cash', amountMinor: retailTotal, reference: 'PM-{{rand}}' }] },
        idempotencyKey: 'pm-sale-{{rand}}', allowed: [200, 201],
      }),
    ),
    request('reception opens a support ticket', 'POST', '/v1/admin/support/tickets', {
      role: 'reception',
      body: { subject: 'Locker will not open', body: 'Reported at the desk.', category: 'facility', memberId: '{{j_memberId}}', branchId: 'br_kor' },
      idempotencyKey: 'pm-ticket-{{rand}}', allowed: [201], extraTests: [setVar('j_ticketId', idOf)],
    }),
    request('the owner replies on the ticket', 'POST', '/v1/admin/support/tickets/{{j_ticketId}}/reply', {
      role: 'owner', body: { body: 'We have opened it with the master key.', internal: false }, allowed: [200, 201],
    }),
    request('the owner resolves the ticket', 'POST', '/v1/admin/support/tickets/{{j_ticketId}}/resolve', {
      role: 'owner', body: { resolution: 'Locker opened and the lock replaced.' }, allowed: [200],
    }),
    request('reception may not refund', 'POST', '/v1/admin/billing/payments/{{j_paymentId}}/refund', {
      role: 'reception', body: { amountMinor: 10000, reason: 'Postman refund probe' }, allowed: [403],
    }),
    request('the accountant refunds ₹100', 'POST', '/v1/admin/billing/payments/{{j_paymentId}}/refund', {
      role: 'accountant', body: { amountMinor: 10000, reason: 'Member changed their mind' }, idempotencyKey: 'pm-refund-{{rand}}', allowed: [200, 201],
    }),
    request('the invoice notes the refund', 'GET', '/v1/admin/billing/invoices/{{j_invoiceId}}/tax-invoice', {
      role: 'owner', query: 'format=html', allowed: [200],
      extraTests: [
        `pm.test('refund shown', function () { const t = pm.response.text(); pm.expect(t).to.include('Refunded');${gstin ? ` pm.expect(t).to.include('does not issue GST credit notes');` : ''} });`,
      ],
    }),
    request('a trainer cannot see the money', 'GET', '/v1/admin/billing/invoices/{{j_invoiceId}}', { role: 'trainer', allowed: [403] }),
    request('another gym cannot see the new member', 'GET', '/v1/admin/members/{{j_memberId}}', { role: 'reef', allowed: [404] }),
    request('today’s revenue report counts the sale', 'GET', '/v1/admin/reports/revenue', {
      role: 'owner', query: 'from={{today}}&to={{today}}', allowed: [200],
      extraTests: [`pm.test('totals present', function () { pm.expect(pm.response.json().totals).to.not.eql(null); });`],
    }),
    request('a mistyped GSTIN is refused on save', 'PATCH', '/v1/admin/settings/business', {
      role: 'owner', body: { taxProfile: { registrationNumber: '29AABCS1429B1ZR', label: 'GST', defaultRateBp: 1800, pricesIncludeTax: false } }, allowed: [422],
    }),
    request('the exercise library is not empty', 'GET', '/v1/admin/training/exercises', {
      role: 'owner', query: 'archived=false', allowed: [200],
      extraTests: [`pm.test('49 shared exercises', function () { pm.expect(pm.response.json().items.length).to.be.at.least(49); });`],
    }),
    // Member side
    request('member home loads', 'GET', '/v1/member/home', { role: 'member', allowed: [200] }),
    ...needing(['memberSessionId'], 'member books a class', (label) =>
      request(label, 'POST', '/v1/member/schedule/book', {
        role: 'member', body: { sessionId: ids.memberSessionId, idempotencyKey: 'pm-mbook-{{rand}}', acceptDropInCharge: false }, allowed: [200],
        extraTests: [setVar('m_bookingId', 'pm.response.json().booking.id')],
      }),
    ),
    ...needing(['memberSessionId'], 'member cancels that booking', (label) => request(label, 'DELETE', '/v1/member/schedule/booking/{{m_bookingId}}', { role: 'member', allowed: [200] })),
    ...needing(['benchId'], 'member logs a workout', workout),
    ...needing(['benchId'], 'the same workout sent again is not logged twice', workout),
    ...needing(['amanHabitId'], 'member logs a habit', (label) =>
      request(label, 'POST', '/v1/member/habits/log', {
        role: 'member', body: { habitId: ids.amanHabitId, onDate: '{{today}}', value: 1, clientId: 'pm-h-{{rand}}' }, allowed: [200, 201],
      }),
    ),
    ...needing(['conversationId'], 'member messages their coach', (label) =>
      request(label, 'POST', `/v1/member/messages/${ids.conversationId}`, {
        role: 'member', body: { body: 'Postman says hello', clientId: 'pm-msg-{{rand}}' }, allowed: [200, 201],
      }),
    ),
    request('member billing labels each invoice', 'GET', '/v1/member/billing', {
      role: 'member', allowed: [200],
      extraTests: [`pm.test('documents labelled', function () { const inv = pm.response.json().invoices; pm.expect(inv.length).to.be.above(0); pm.expect(inv[0].document.title).to.be.oneOf(['Tax invoice', 'Invoice']); });`],
    }),
    ...needing(['amanInvoice'], 'member opens their own invoice', (label) =>
      request(label, 'GET', `/v1/member/billing/invoices/${ids.amanInvoice}/tax-invoice`, {
        role: 'member', query: 'format=html', allowed: [200],
        extraTests: [`pm.test('printable', function () { pm.expect(pm.response.text()).to.match(/<h1>(Tax invoice|Invoice)<\\/h1>/); });`],
      }),
    ),
    request('online checkout is refused honestly', 'POST', '/v1/member/billing/checkout-intent', { role: 'member', body: {}, allowed: [400, 409, 412, 422] }),
    request('the platform admin lists customers', 'GET', '/v1/platform/tenants', {
      role: 'platform', allowed: [200],
      extraTests: [`pm.test('both gyms', function () { const t = JSON.stringify(pm.response.json()); pm.expect(t).to.include('shark'); pm.expect(t).to.include('reef'); });`],
    }),
  ];

  /* ——— 4. Every write route with an empty body: a 4xx, never a 5xx ——— */
  const LAST = new Set(['POST /v1/auth/sign-out']);
  const writeSweep = [];
  const lastOnes = [];
  for (const { method, path } of routes) {
    if (method === 'GET') continue;
    const filled = ACTS_WITHOUT_BODY.has(`${method} ${path}`) ? path.replace(/:([A-Za-z]+)/g, (_m, name) => `unknown_${name}`) : fill(path).filled;
    let role = 'owner';
    if (path.startsWith('/v1/member/')) role = 'member';
    else if (path.startsWith('/v1/platform/')) role = 'platform';
    else if (path.startsWith('/v1/auth/') && !['/v1/auth/activation/issue', '/v1/auth/recovery/issue'].includes(path)) role = null;
    const item = request(`${role ?? 'anonymous'} ${method} ${path} with an empty body`, method, filled, { role, body: {}, allowed: null });
    (LAST.has(`${method} ${path}`) ? lastOnes : writeSweep).push(item);
  }

  const today = localDate(now);
  const collection = {
    info: {
      name: `Shark Fitness API — every route${readOnly ? ' (read-only)' : ''}`,
      description: `Generated for ${baseUrl} at ${new Date(now).toISOString()} by scripts/postman/generate.mjs.`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    event: [
      {
        listen: 'prerequest',
        script: {
          type: 'text/javascript',
          exec: [
            `if (!pm.collectionVariables.get('rand')) pm.collectionVariables.set('rand', String(Date.now()).slice(-8));`,
            `pm.collectionVariables.set('nowIso', new Date().toISOString());`,
            `pm.collectionVariables.set('startedIso', new Date(Date.now() - 3600000).toISOString());`,
            `var t = new Date(Date.now() + 86400000); t.setUTCHours(6, 30, 0, 0); pm.collectionVariables.set('tomorrowNoonIso', t.toISOString()); pm.collectionVariables.set('tomorrowOnePmIso', new Date(t.getTime() + 3600000).toISOString());`,
          ],
        },
      },
      // One line per response, which run.mjs counts.
      { listen: 'test', script: { type: 'text/javascript', exec: [`console.log('R|' + pm.info.requestId + '|' + pm.response.code);`] } },
    ],
    variable: [
      { key: 'today', value: today },
      { key: 'from', value: localDate(now - 30 * DAY) },
      { key: 'to', value: localDate(now - DAY) },
    ],
    item: [
      { name: '0 Sessions', item: sessionChecks },
      { name: '1 Security and transport', item: security },
      { name: '2 Every GET route by role', item: getSweep },
      ...(readOnly
        ? []
        : [
            { name: '3 Journeys', item: journeys },
            { name: '4 Every write route, empty body', item: [...writeSweep, ...lastOnes] },
          ]),
    ],
  };

  mkdirSync(outDir, { recursive: true });
  const collectionPath = join(outDir, 'collection.json');
  const envPath = join(outDir, 'env.json');
  writeFileSync(collectionPath, JSON.stringify(collection, null, 2));
  writeFileSync(
    envPath,
    JSON.stringify(
      {
        name: baseUrl,
        values: [
          { key: 'baseUrl', value: baseUrl, enabled: true },
          ...Object.entries(sessions).flatMap(([role, { session, csrf }]) => [
            { key: `${role}_session`, value: session, enabled: true, type: 'secret' },
            { key: `${role}_csrf`, value: csrf, enabled: true, type: 'secret' },
          ]),
        ],
      },
      null,
      2,
    ),
  );

  const count = collection.item.reduce((n, folder) => n + folder.item.length, 0);
  console.log(`${count} requests written to ${collectionPath}`);
  console.log(`  ${collection.item.map((folder) => `${folder.name}: ${folder.item.length}`).join(' · ')}`);
  if (!servesApps) console.log('  This server does not serve the apps, so the two app-shell checks are left out.');
  for (const name of missing) console.log(`  Not found on this server, so its routes expect 404: ${name}`);
  if (!readOnly) for (const step of skipped) console.log(`  Journey step left out: ${step}`);
  return { collection, collectionPath, envPath, outDir };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  generate(parseOptions(process.argv.slice(2))).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
