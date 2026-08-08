import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';

interface BrowserSession {
  cookie: string;
  csrfToken: string;
}

async function signIn(email = 'reception@sharkfitness.in'): Promise<BrowserSession> {
  const response = await app.request('/v1/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    body: JSON.stringify({ tenantSlug: 'shark', email, password: 'shark1234' }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { csrfToken: string };
  const setCookie = response.headers.get('set-cookie') ?? '';
  const session = setCookie.match(/shark_session=([^;,]+)/)?.[1];
  return { cookie: `shark_session=${session}; shark_csrf=${body.csrfToken}`, csrfToken: body.csrfToken };
}

function headers(session: BrowserSession, unsafe = false): Record<string, string> {
  return {
    cookie: session.cookie,
    origin: 'http://localhost:5173',
    ...(unsafe ? { 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' } : {}),
  };
}

describe('admin leads', () => {
  it('lists seeded leads scoped to the tenant', async () => {
    const session = await signIn();
    const response = await app.request('/v1/admin/leads', { headers: headers(session) });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { total: number; items: Array<{ stage: string }> };
    expect(body.total).toBeGreaterThan(0);
    expect(body.items.every((l) => typeof l.stage === 'string')).toBe(true);
  });

  it('creates a lead, detects a duplicate, and rejects an illegal stage jump', async () => {
    const session = await signIn();
    const tenant = db.select().from(schema.tenants).where(eq(schema.tenants.slug, 'shark')).get()!;
    const branch = db.select().from(schema.branches).where(eq(schema.branches.tenantId, tenant.id)).get()!;

    const create = await app.request('/v1/admin/leads', {
      method: 'POST',
      headers: headers(session, true),
      body: JSON.stringify({
        name: 'Integration Test Lead',
        phone: '+91 9000000001',
        source: 'walk_in',
        branchId: branch.id,
        expectedValueMinor: 500000,
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { id: string };

    const dupe = await app.request('/v1/admin/leads', {
      method: 'POST',
      headers: headers(session, true),
      body: JSON.stringify({ name: 'Same Person Again', phone: '+91 9000000001', source: 'call', branchId: branch.id }),
    });
    expect(dupe.status).toBe(201);
    const dupeBody = (await dupe.json()) as { duplicateOfId: string | null };
    expect(dupeBody.duplicateOfId).toBe(created.id);

    const illegalJump = await app.request(`/v1/admin/leads/${created.id}/stage`, {
      method: 'POST',
      headers: headers(session, true),
      body: JSON.stringify({ to: 'won' }),
    });
    expect(illegalJump.status).toBe(409);

    const legalMove = await app.request(`/v1/admin/leads/${created.id}/stage`, {
      method: 'POST',
      headers: headers(session, true),
      body: JSON.stringify({ to: 'contacted' }),
    });
    expect(legalMove.status).toBe(200);
  });

  it('converts a lead to a member and blocks a second conversion', async () => {
    const session = await signIn();
    const tenant = db.select().from(schema.tenants).where(eq(schema.tenants.slug, 'shark')).get()!;
    const branch = db.select().from(schema.branches).where(eq(schema.branches.tenantId, tenant.id)).get()!;

    const create = await app.request('/v1/admin/leads', {
      method: 'POST',
      headers: headers(session, true),
      body: JSON.stringify({ name: 'Convert Me', phone: '+91 9000000099', source: 'trial', branchId: branch.id }),
    });
    const { id: leadId } = (await create.json()) as { id: string };

    const convert = await app.request(`/v1/admin/leads/${leadId}/convert`, { method: 'POST', headers: headers(session, true) });
    expect(convert.status).toBe(200);
    const converted = (await convert.json()) as { memberId: string; memberNo: string; message: string };
    expect(converted.memberNo).toMatch(/^SF-\d+$/);
    expect(converted.message).toMatch(/pending/i);

    const member = db.select().from(schema.members).where(eq(schema.members.id, converted.memberId)).get();
    expect(member?.lifecycle).toBe('trial');

    const secondConvert = await app.request(`/v1/admin/leads/${leadId}/convert`, { method: 'POST', headers: headers(session, true) });
    expect(secondConvert.status).toBe(409);
  });

  it('rejects lead access for a role without lead.view', async () => {
    // rehan@sharkfitness.in is seeded as a trainer, and the trainer permission
    // set (packages/domain/src/permissions.ts) does not include lead.view.
    const session = await signIn('rehan@sharkfitness.in');
    const response = await app.request('/v1/admin/leads', { headers: headers(session) });
    expect(response.status).toBe(403);
  });
});
