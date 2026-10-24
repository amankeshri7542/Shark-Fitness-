import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema, sqlite, transact } from '../db/client.js';
import { hashPassword, hashToken } from '../lib/crypto.js';
import { resolveSession } from '../services/auth.js';
import { enrollMember } from '../services/member-enrollment.js';
import { parseRosterCsv } from '../services/roster-import.js';
import { now } from '../lib/time.js';

const origin = 'http://localhost:5173';
type Session = { cookie: string; csrf: string };
let owner: Session; let reception: Session; let trainer: Session;
async function login(email: string, password = 'shark1234') {
  const res = await app.request('/v1/auth/password', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ tenantSlug: 'shark', email, password }) });
  expect(res.status).toBe(200);
  const body = await res.json() as { csrfToken: string }; const token = res.headers.get('set-cookie')!.match(/shark_session=([^;,]+)/)![1]!;
  return { cookie: `shark_session=${token}; shark_csrf=${body.csrfToken}`, csrf: body.csrfToken };
}
function request(session: Session, path: string, body?: unknown, options: { method?: string; key?: string; branch?: string } = {}) {
  return app.request(`/v1${path}`, { method: options.method ?? (body ? 'POST' : 'GET'), headers: { origin, cookie: session.cookie, 'content-type': 'application/json', 'x-csrf-token': session.csrf,
    ...(options.key ? { 'idempotency-key': options.key } : {}), ...(options.branch ? { 'x-branch-id': options.branch } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
function ownerContext() { return resolveSession(owner.cookie.match(/shark_session=([^;]+)/)![1]!)!; }
function fixture(email = `${randomUUID()}@member-ops.test`) {
  const created = transact(() => enrollMember(ownerContext(), { name: 'Synthetic Original', branchId: 'br_kor', email, phone: null }));
  return { ...created, email };
}
function snapshot() {
  return Object.fromEntries(['users', 'members', 'memberships', 'invoices', 'payments', 'refunds', 'audit_log', 'outbox_events', 'idempotency_keys'].map((table) => [table, sqlite.prepare(`select count(*) n from ${table}`).get()]));
}
function profile(version = 1) { return { version, firstName: 'Corrected', lastName: 'Person', dob: '1990-02-02', addressLine: '12 Test Road', emergencyContact: { name: 'Synthetic Contact', phone: '+91 98765 43210', relationship: 'Sibling' }, reason: 'Corrected verified profile typo' }; }
function roster(count: number) {
  const batch = randomUUID();
  return { branchId: 'br_kor', mapping: {}, csv: `firstName,lastName,email,phone\r\n${Array.from({ length: count }, (_, i) => `Imported,Person ${i},${batch}-${i}@roster.test,`).join('\r\n')}` };
}
beforeAll(async () => { owner = await login('owner@sharkfitness.in'); reception = await login('reception@sharkfitness.in'); trainer = await login('rehan@sharkfitness.in'); });

describe('member corrections', () => {
  it('finds a full name and member number through the normal scoped directory', async () => {
    const member = db.select().from(schema.members).where(eq(schema.members.email, 'rohit@sharkfitness.in')).get()!;
    for (const q of [`${member.firstName} ${member.lastName}`, member.memberNo]) {
      const res = await request(reception, `/admin/members?q=${encodeURIComponent(q)}`);
      expect(res.status).toBe(200); const body = await res.json() as { items: Array<{ id: string }> };
      expect(body.items.map((m) => m.id)).toContain(member.id);
    }
  });
  it('corrects profile/emergency fields atomically, preserves login and financial facts, rejects stale/forbidden edits', async () => {
    const member = fixture();
    const res = await request(reception, `/admin/members/${member.memberId}/profile`, profile(), { method: 'PATCH' });
    expect(res.status).toBe(200);
    const saved = db.select().from(schema.members).where(eq(schema.members.id, member.memberId)).get()!;
    const user = db.select().from(schema.users).where(eq(schema.users.id, member.userId)).get()!;
    expect(saved).toMatchObject({ firstName: 'Corrected', lastName: 'Person', version: 2, email: member.email, emergencyContact: profile().emergencyContact });
    expect(user).toMatchObject({ name: 'Corrected Person', email: member.email, accountState: 'invited', passwordHash: null });
    const before = snapshot();
    expect((await request(reception, `/admin/members/${member.memberId}/profile`, profile(), { method: 'PATCH' })).status).toBe(409);
    expect((await request(trainer, `/admin/members/${member.memberId}/profile`, profile(2), { method: 'PATCH' })).status).toBe(403);
    expect((await request(owner, `/admin/members/${member.memberId}/profile`, profile(2), { method: 'PATCH', branch: 'br_hsr' })).status).toBe(404);
    expect((await request(reception, `/admin/members/${member.memberId}/profile`, { ...profile(2), email: 'unverified@member-ops.test' }, { method: 'PATCH' })).status).toBe(422);
    expect(snapshot()).toEqual(before);
    expect(db.select().from(schema.memberships).where(eq(schema.memberships.memberId, member.memberId)).all()).toHaveLength(0);
  });
  it('requires fresh owner authority for unique identity corrections and invalidates old credentials handoffs/sessions', async () => {
    const member = fixture(); const password = 'synthetic-private-password';
    db.update(schema.users).set({ passwordHash: hashPassword(password), accountState: 'active' }).where(eq(schema.users.id, member.userId)).run();
    const oldSession = await login(member.email, password);
    const challengeId = randomUUID();
    db.insert(schema.otpChallenges).values({ id: challengeId, tenantId: ownerContext().tenantId, identifier: member.email.toUpperCase(), codeHash: hashToken(`${challengeId}:123456`), attempts: 0, createdAt: now(), expiresAt: now() + 60_000, consumedAt: null }).run();
    const input = { version: 1, email: `${randomUUID()}@changed.test`, phone: null, identityVerified: true, currentPassword: 'shark1234', reason: 'Verified mistaken login email in person' };
    const before = snapshot();
    expect((await request(reception, `/admin/members/${member.memberId}/identity`, input, { method: 'PATCH' })).status).toBe(403);
    expect((await request(owner, `/admin/members/${member.memberId}/identity`, { ...input, currentPassword: 'wrong-password' }, { method: 'PATCH' })).status).toBe(403);
    expect((await request(owner, `/admin/members/${member.memberId}/identity`, { ...input, email: 'OWNER@sharkfitness.in' }, { method: 'PATCH' })).status).toBe(409);
    expect((await request(owner, `/admin/members/${member.memberId}/identity`, { ...input, email: null, phone: '9998887776' }, { method: 'PATCH' })).status).toBe(409);
    expect(snapshot()).toEqual(before);
    expect((await request(owner, `/admin/members/${member.memberId}/identity`, input, { method: 'PATCH' })).status).toBe(200);
    expect(db.select().from(schema.otpChallenges).where(eq(schema.otpChallenges.id, challengeId)).get()!.consumedAt).not.toBeNull();
    expect((await request(oldSession, '/me')).status).toBe(401);
    const signedIn = await login(input.email, password);
    expect((await request(signedIn, '/me')).status).toBe(200);
    expect(db.select().from(schema.members).where(eq(schema.members.id, member.memberId)).get()).toMatchObject({ email: input.email, emailNormalized: input.email, version: 2 });
  });
});

describe('contact roster import', () => {
  it('previews 51+ rows without writes; reports conflicts, imports only confirmed valid contacts and replays exactly', async () => {
    const input = roster(51); input.csv += '\r\nExisting,Contact,rohit@sharkfitness.in,\r\nInvalid,Contact,not-an-email,\r\nDup,One,duplicate@roster.test,\r\nDup,Two,duplicate@roster.test,';
    const before = snapshot();
    const response = await request(reception, '/admin/members/imports/preview', input); expect(response.status).toBe(200);
    const preview = await response.json() as { previewToken: string; ready: number; rejected: number; skipped: number };
    expect(preview).toMatchObject({ ready: 51, rejected: 3, skipped: 1 }); expect(snapshot()).toEqual(before);
    const body = { ...input, previewToken: preview.previewToken, confirmed: true }; const key = randomUUID();
    expect((await request(reception, '/admin/members/imports/commit', body)).status).toBe(422);
    const commit = await request(reception, '/admin/members/imports/commit', body, { key }); expect(commit.status).toBe(200);
    const result = await commit.json() as { imported: number; skipped: number; rejected: number; rows: Array<{ memberId?: string }> };
    expect(result).toMatchObject({ imported: 51, skipped: 1, rejected: 3 });
    const after = snapshot(); expect(await (await request(reception, '/admin/members/imports/commit', body, { key })).json()).toEqual(result); expect(snapshot()).toEqual(after);
    expect((await request(owner, '/admin/members/imports/commit', body, { key })).status).toBe(409);
    expect((await request(reception, '/admin/members/imports/commit', { ...body, branchId: 'br_ind' }, { key })).status).toBe(404);
    const created = result.rows.filter((row) => row.memberId).map((row) => row.memberId!); expect(created).toHaveLength(51);
    for (const memberId of created) {
      const member = db.select().from(schema.members).where(eq(schema.members.id, memberId)).get()!;
      expect(db.select().from(schema.users).where(eq(schema.users.id, member.userId!)).get()).toMatchObject({ accountState: 'invited', passwordHash: null, role: 'member' });
      expect(db.select().from(schema.invoices).where(eq(schema.invoices.memberId, memberId)).all()).toHaveLength(0);
    }
    // One imported person goes through the real first-time activation API, not a prepared password.
    const issued = await request(reception, '/auth/activation/issue', { memberId: created[0] }); expect(issued.status).toBe(200);
    const activation = await issued.json() as { activationId: string; token: string; email: string };
    const activated = await app.request('/v1/auth/activation/redeem', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ activationId: activation.activationId, token: activation.token, password: 'imported-private-password' }) });
    expect(activated.status).toBe(200); expect((await request(await login(activation.email, 'imported-private-password'), '/member/billing')).status).toBe(200);
  });
  it('rejects changed/stale/expired previews and unauthorized preview with no partial writes', async () => {
    const input = roster(1); const res = await request(reception, '/admin/members/imports/preview', input); const preview = await res.json() as { previewToken: string };
    const body = { ...input, previewToken: preview.previewToken, confirmed: true }; const before = snapshot();
    expect((await request(trainer, '/admin/members/imports/preview', input)).status).toBe(403);
    expect((await request(reception, '/admin/members/imports/commit', { ...body, csv: input.csv.replace('Imported', 'Changed') }, { key: randomUUID() })).status).toBe(409);
    expect((await request(reception, '/admin/members/imports/commit', { ...body, previewToken: '1.expired' }, { key: randomUUID() })).status).toBe(409); expect(snapshot()).toEqual(before);
    fixture(input.csv.split('\r\n')[1]!.split(',')[2]); const afterConflict = snapshot();
    expect((await request(reception, '/admin/members/imports/commit', body, { key: randomUUID() })).status).toBe(409); expect(snapshot()).toEqual(afterConflict);
  });
  it('rolls back the whole batch on interruption and then safely retries', async () => {
    const input = roster(2); const response = await request(owner, '/admin/members/imports/preview', input); const preview = await response.json() as { previewToken: string };
    const body = { ...input, previewToken: preview.previewToken, confirmed: true }; const key = randomUUID(); const before = snapshot();
    sqlite.exec("CREATE TEMP TRIGGER fail_import_proof BEFORE INSERT ON audit_log WHEN NEW.action = 'roster.imported' BEGIN SELECT RAISE(ABORT, 'synthetic interrupted import'); END");
    try { expect((await request(owner, '/admin/members/imports/commit', body, { key })).status).toBe(500); expect(snapshot()).toEqual(before); }
    finally { sqlite.exec('DROP TRIGGER fail_import_proof'); }
    expect(await (await request(owner, '/admin/members/imports/commit', body, { key })).json()).toMatchObject({ imported: 2, skipped: 0, rejected: 0 });
  });
  it('supports mapped quoted CSV and rejects malformed/beyond-limit input', async () => {
    expect(parseRosterCsv('\uFEFFName,Note\r\n"Comma, Name","quoted ""word""\nline"')).toEqual([['Name', 'Note'], ['Comma, Name', 'quoted "word"\nline']]);
    expect(() => parseRosterCsv('Name\n"unfinished')).toThrow();
    expect(() => parseRosterCsv('Name\n' + Array.from({ length: 201 }, () => 'Person').join('\n'))).toThrow();
    const res = await request(owner, '/admin/members/imports/preview', { branchId: 'br_kor', csv: `Given,Email\nMapped,${randomUUID()}@mapped.test`, mapping: { firstName: 'Given', email: 'Email' } });
    expect(await res.json()).toMatchObject({ ready: 1, rejected: 0 });
  });
});
