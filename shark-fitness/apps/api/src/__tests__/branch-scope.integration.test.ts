import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../app.js';

/* ============================================================================
   Branch scope — what a request covers when nobody says.

   The console's branch switcher calls "nothing selected" *All branches*, and
   says so by sending no `x-branch-id` header at all. The server read that
   absence as the session's default branch — the first one the caller happened
   to be assigned — so an owner of three gyms read a screen labelled "All
   branches (3)" over one gym's figures. Nothing errored. The number was simply
   a third of the truth, which is the worst kind of wrong a report can be.

   A single-branch tenant cannot see this bug: both readings agree there. So
   every case below is stated against a caller who holds three branches and a
   caller who holds one, and the pair is the test.
   ========================================================================= */

interface Session {
  cookie: string;
  csrfToken: string;
}

const cache = new Map<string, Session>();

async function signIn(email: string): Promise<Session> {
  const cached = cache.get(email);
  if (cached) return cached;
  const response = await app.request('/v1/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    body: JSON.stringify({ tenantSlug: 'shark', email, password: 'shark1234' }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { csrfToken: string };
  const token = (response.headers.get('set-cookie') ?? '').match(/shark_session=([^;,]+)/)?.[1];
  const session = { cookie: `shark_session=${token}; shark_csrf=${body.csrfToken}`, csrfToken: body.csrfToken };
  cache.set(email, session);
  return session;
}

function headers(session: Session, unsafe = false, branchId?: string): Record<string, string> {
  return {
    cookie: session.cookie,
    origin: 'http://localhost:5173',
    ...(branchId !== undefined ? { 'x-branch-id': branchId } : {}),
    ...(unsafe ? { 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' } : {}),
  };
}

const get = (session: Session, path: string, branchId?: string) =>
  app.request(path, { headers: headers(session, false, branchId) });

/** Owner: every branch. Manager: Koramangala only (see the seed). */
let owner: Session;
let manager: Session;

beforeAll(async () => {
  owner = await signIn('owner@sharkfitness.in');
  manager = await signIn('manager@sharkfitness.in');
});

/* ——— The header is the only thing that narrows a request ——————— */

describe('branch scope — no header means every branch the caller may see', () => {
  it('gives the owner all three branches on /me/branches, and selects none', async () => {
    const body = (await (await get(owner, '/v1/me/branches')).json()) as {
      items: Array<{ id: string }>;
      activeBranchId: string | null;
    };
    expect(body.items.length).toBeGreaterThan(1);
    // The session no longer pre-selects a branch. A default here is what made
    // "All branches" a lie: the console showed one label and got another scope.
    expect(body.activeBranchId).toBeNull();
  });

  it('covers every branch in the member directory when no branch is named', async () => {
    const body = (await (await get(owner, '/v1/admin/members?limit=100')).json()) as {
      items: Array<{ branchName: string }>;
      scopeNote: string;
    };
    expect(new Set(body.items.map((m) => m.branchName)).size).toBeGreaterThan(1);
    // The note the operator reads has to describe the scope they actually got.
    expect(body.scopeNote).toContain('all');
  });

  it('covers every branch on the dashboard when no branch is named', async () => {
    const body = (await (await get(owner, '/v1/admin/dashboard')).json()) as {
      scope: { branchIds: string[]; allBranches: boolean };
    };
    expect(body.scope.branchIds.length).toBeGreaterThan(1);
    expect(body.scope.allBranches).toBe(true);
  });

  it('covers every branch in the leads pipeline when no branch is named', async () => {
    const body = (await (await get(owner, '/v1/admin/leads?limit=100')).json()) as {
      items: Array<{ branchId?: string; branchName?: string }>;
    };
    const named = body.items.map((l) => l.branchName ?? l.branchId).filter(Boolean);
    expect(new Set(named).size).toBeGreaterThan(1);
  });

  it('covers every branch in billing invoices when no branch is named', async () => {
    const all = (await (await get(owner, '/v1/admin/billing/invoices?limit=100')).json()) as { total: number };
    const one = (await (await get(owner, '/v1/admin/billing/invoices?limit=100', 'br_kor')).json()) as { total: number };
    // A narrowed scope is a strict subset. Before the fix these two were equal,
    // because the unfiltered read was already scoped to br_kor.
    expect(all.total).toBeGreaterThan(one.total);
  });

  it('covers every branch in the facility board when no branch is named', async () => {
    const body = (await (await get(owner, '/v1/admin/facility/equipment')).json()) as {
      scope: { branchIds: string[]; allBranches: boolean };
    };
    expect(body.scope.branchIds.length).toBeGreaterThan(1);
    expect(body.scope.allBranches).toBe(true);
  });

  it('covers every branch in the staff directory when no branch is named', async () => {
    const all = (await (await get(owner, '/v1/admin/staff')).json()) as { items: Array<{ id: string }> };
    const one = (await (await get(owner, '/v1/admin/staff', 'br_kor')).json()) as { items: Array<{ id: string }> };
    expect(all.items.length).toBeGreaterThanOrEqual(one.items.length);
    expect(all.items.length).toBeGreaterThan(0);
  });
});

describe('branch scope — a header narrows the request, and only to a permitted branch', () => {
  it('restricts the member directory to the named branch', async () => {
    const body = (await (await get(owner, '/v1/admin/members?limit=100', 'br_ind')).json()) as {
      items: Array<{ branchName: string }>;
      scopeNote: string;
    };
    expect(body.items.length).toBeGreaterThan(0);
    for (const m of body.items) expect(m.branchName).toBe('Indiranagar Reef');
    expect(body.scopeNote).toContain('Indiranagar Reef');
  });

  it('restricts the dashboard to the named branch and stops calling it all branches', async () => {
    const body = (await (await get(owner, '/v1/admin/dashboard', 'br_ind')).json()) as {
      scope: { branchIds: string[]; allBranches: boolean };
    };
    expect(body.scope.branchIds).toEqual(['br_ind']);
    expect(body.scope.allBranches).toBe(false);
  });

  it('refuses a branch the caller does not hold rather than silently ignoring it', async () => {
    // Silently falling back to the caller's own scope is the tempting reading,
    // and it is wrong: the client asked a question about Indiranagar and would
    // be handed Koramangala's answer under Indiranagar's label.
    const response = await get(manager, '/v1/admin/members', 'br_ind');
    expect(response.status).toBe(403);
  });

  it('refuses a branch id that belongs to no tenant at all, the same way', async () => {
    const response = await get(owner, '/v1/admin/members', 'br_not_a_real_branch');
    expect(response.status).toBe(403);
  });

  it('treats an empty header as no selection rather than as a branch', async () => {
    const response = await get(owner, '/v1/admin/members?limit=100', '');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<{ branchName: string }> };
    expect(new Set(body.items.map((m) => m.branchName)).size).toBeGreaterThan(1);
  });
});

describe('branch scope — a single-branch user is unaffected', () => {
  it('shows the manager their own branch with or without the header', async () => {
    const bare = (await (await get(manager, '/v1/admin/members?limit=100')).json()) as {
      items: Array<{ branchName: string }>;
    };
    const named = (await (await get(manager, '/v1/admin/members?limit=100', 'br_kor')).json()) as {
      items: Array<{ branchName: string }>;
    };
    expect(bare.items.length).toBe(named.items.length);
    expect(bare.items.length).toBeGreaterThan(0);
    for (const m of bare.items) expect(m.branchName).toBe('Koramangala Depot');
  });
});

