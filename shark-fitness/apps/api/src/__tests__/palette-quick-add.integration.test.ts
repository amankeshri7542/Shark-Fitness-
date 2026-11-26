import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { call, signIn, type TestSession } from './helpers/session.js';

/* ============================================================================
   Command palette search and quick add for walk-ins (P07 AC7, AC8 server half;
   PRD 01 §4.2, §4.4; Design PRD UX-A04).
   ========================================================================= */

let owner: TestSession;
let reception: TestSession;
let trainer: TestSession;
let accountant: TestSession;
const createdMemberIds: string[] = [];

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

interface Search {
  results: Array<{ type: string; id: string; title: string; to: string }>;
}

beforeAll(async () => {
  [owner, reception, trainer, accountant] = await Promise.all([
    signIn('owner@sharkfitness.in'),
    signIn('reception@sharkfitness.in'),
    signIn('rehan@sharkfitness.in'),
    signIn('accounts@sharkfitness.in'),
  ]);
});

afterAll(() => {
  if (!createdMemberIds.length) return;
  const members = db.select().from(schema.members).where(inArray(schema.members.id, createdMemberIds)).all();
  const userIds = members.map((m) => m.userId).filter((u): u is string => Boolean(u));
  const memberships = db.select({ id: schema.memberships.id }).from(schema.memberships).where(inArray(schema.memberships.memberId, createdMemberIds)).all().map((m) => m.id);
  const invoices = db.select({ id: schema.invoices.id }).from(schema.invoices).where(inArray(schema.invoices.memberId, createdMemberIds)).all().map((i) => i.id);
  if (invoices.length) db.delete(schema.invoiceLines).where(inArray(schema.invoiceLines.invoiceId, invoices)).run();
  if (invoices.length) db.delete(schema.invoices).where(inArray(schema.invoices.id, invoices)).run();
  if (memberships.length) db.delete(schema.membershipEvents).where(inArray(schema.membershipEvents.membershipId, memberships)).run();
  if (memberships.length) db.delete(schema.memberships).where(inArray(schema.memberships.id, memberships)).run();
  db.delete(schema.members).where(inArray(schema.members.id, createdMemberIds)).run();
  if (userIds.length) {
    db.delete(schema.sessions).where(inArray(schema.sessions.userId, userIds)).run();
    db.delete(schema.users).where(inArray(schema.users.id, userIds)).run();
  }
});

describe('palette search', () => {
  it('finds a member by name and returns where to open them', async () => {
    const body = await json<Search>(await call(owner, 'GET', '/v1/admin/search?q=aman'));
    const aman = body.results.find((r) => r.type === 'member' && r.title === 'Aman Mehra');
    expect(aman?.to).toMatch(/^\/members\/mbr_/);
  });

  it('searches only what the role may open', async () => {
    const trainerHits = await json<Search>(await call(trainer, 'GET', '/v1/admin/search?q=rohit'));
    // Rohit is Nikhil's member, not Rehan's.
    expect(trainerHits.results.filter((r) => r.type === 'member')).toHaveLength(0);
    expect(trainerHits.results.some((r) => r.type === 'invoice' || r.type === 'lead')).toBe(false);

    const accountantHits = await json<Search>(await call(accountant, 'GET', '/v1/admin/search?q=an&types=lead'));
    expect(accountantHits.results).toHaveLength(0);
  });

  it('narrows to outstanding invoices for the record-payment step', async () => {
    const body = await json<Search>(await call(reception, 'GET', '/v1/admin/search?q=inv&types=invoice&outstanding=1'));
    expect(body.results.every((r) => r.type === 'invoice' && r.to.startsWith('/billing?invoice='))).toBe(true);
  });

  it('refuses a one-letter query and escapes wildcards', async () => {
    expect((await call(owner, 'GET', '/v1/admin/search?q=a')).status).toBe(422);
    const wild = await json<Search>(await call(owner, 'GET', '/v1/admin/search?q=%25%25'));
    expect(wild.results).toHaveLength(0);
  });
});

describe('quick add', () => {
  it('adds a walk-in, and the new member can be activated and sign in', async () => {
    const phone = `+9198${String(Date.now()).slice(-8)}`;
    const email = `walkin-${Date.now()}@example.test`;
    const response = await call(reception, 'POST', '/v1/admin/members/quick-add', { name: 'Kabir Walkin', phone, email, branchId: 'br_kor' });
    expect(response.status).toBe(201);
    const created = await json<{ member: { id: string; memberNo: string }; activation: { eligible: boolean } }>(response);
    createdMemberIds.push(created.member.id);
    expect(created.activation.eligible).toBe(true);
    expect(created.member.memberNo).toMatch(/^SF-/);

    const issued = await json<{ activationId: string; token: string; tenantSlug: string }>(
      await call(reception, 'POST', '/v1/auth/activation/issue', { memberId: created.member.id }),
    );
    const redeemed = await app.request('/v1/auth/activation/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ activationId: issued.activationId, token: issued.token, password: 'a-long-walkin-password' }),
    });
    expect(redeemed.status).toBe(200);
    expect((await json<{ viewer: { role: string } }>(redeemed)).viewer.role).toBe('member');

    // Duplicate phone: refused with a link to the member just created.
    const again = await call(reception, 'POST', '/v1/admin/members/quick-add', { name: 'Kabir Again', phone, branchId: 'br_kor' });
    expect(again.status).toBe(409);
    const conflict = await json<{ error: { message: string; details: { existing: { id: string; matchedOn: string } } } }>(again);
    expect(conflict.error.details.existing).toMatchObject({ id: created.member.id, matchedOn: 'phone' });
    expect(conflict.error.message).toMatch(/Open their record instead/);

    const check = await json<{ duplicate: { id: string } | null }>(await call(reception, 'GET', `/v1/admin/members/quick-add/check?email=${encodeURIComponent(email)}`));
    expect(check.duplicate?.id).toBe(created.member.id);
  });

  it('detects a duplicate email of an existing seeded member', async () => {
    const response = await call(reception, 'POST', '/v1/admin/members/quick-add', {
      name: 'Someone New',
      phone: '+919000011111',
      email: 'aman@sharkfitness.in',
      branchId: 'br_kor',
    });
    expect(response.status).toBe(409);
    const body = await json<{ error: { details: { existing: { name: string; matchedOn: string } } } }>(response);
    expect(body.error.details.existing).toMatchObject({ name: 'Aman Mehra', matchedOn: 'email' });
  });

  it('assigns an optional plan and refuses roles without member.edit', async () => {
    const product = db.select().from(schema.products).where(eq(schema.products.tenantId, 'ten_shark')).all().find((p) => p.kind === 'membership' && p.status === 'active');
    const phone = `+9197${String(Date.now()).slice(-8)}`;
    const response = await call(reception, 'POST', '/v1/admin/members/quick-add', { name: 'Plan Walkin', phone, branchId: 'br_kor', productId: product!.id });
    expect(response.status).toBe(201);
    const body = await json<{ member: { id: string }; membership: unknown; activation: { eligible: boolean } }>(response);
    createdMemberIds.push(body.member.id);
    expect(body.membership).not.toBeNull();
    expect(body.activation.eligible).toBe(false);
    expect((await call(trainer, 'POST', '/v1/admin/members/quick-add', { name: 'No', phone: '+919111122222', branchId: 'br_kor' })).status).toBe(403);
  });
});
