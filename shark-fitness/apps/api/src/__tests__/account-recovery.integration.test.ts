import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { beforeEach, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Role } from '@shark/contracts';
import { app } from '../app.js';
import { bootstrapGym } from '../db/bootstrap.js';
import { db, schema, sqlite } from '../db/client.js';
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import { createSession, resolveSession } from '../services/auth.js';
import { issueAccountRecovery, requireFreshOwner } from '../services/account-recovery.js';
import { issueRealtimeTicket, consumeRealtimeTicket } from '../lib/realtime-ticket.js';
import { attachRealtime } from '../realtime/hub.js';
import { resetRateLimitsForTest } from '../middleware/index.js';

const password = 'synthetic-current-password';
const newPassword = 'synthetic-recovered-password';
const reason = 'Verified the person in person against existing gym records.';
const origin = 'http://localhost:5173';
type Link = { recoveryId: string; token: string; expiresAt: string };
let gym: ReturnType<typeof bootstrapGym>;
let owner: ReturnType<typeof createSession>;

beforeEach(() => {
  resetRateLimitsForTest();
  gym = bootstrapGym({ slug: `recovery-${randomUUID()}`, legalName: 'Synthetic Recovery Gym', displayName: 'Synthetic Recovery Gym', timezone: 'UTC',
    owner: { name: 'Recovery Owner', email: 'owner@recovery.test', password },
    branch: { name: 'Main', slug: 'main', addressLine: 'Synthetic address', city: 'Test', capacity: 50, opensMinutes: 0, closesMinutes: 1440 } });
  owner = createSession(gym.ownerId, gym.tenantId, '127.0.0.1', 'recovery-test');
});

function account(role: Role = 'member', branchId = gym.branchId) {
  const userId = randomUUID(); const recordId = randomUUID(); const at = Date.now();
  const email = `${userId}@recovery.test`;
  db.insert(schema.users).values({ id: userId, tenantId: gym.tenantId, name: 'Synthetic Recipient', initials: 'SR', email, role, accountState: 'active', passwordHash: hashPassword(password), preferences: {}, createdAt: at, updatedAt: at }).run();
  if (role === 'member') db.insert(schema.members).values({ id: recordId, tenantId: gym.tenantId, userId, homeBranchId: branchId, memberNo: recordId, firstName: 'Synthetic', lastName: 'Recipient', initials: 'SR', email, tags: [], lifecycle: 'expired', joinedOn: '2026-01-01', createdAt: at, updatedAt: at }).run();
  else db.insert(schema.staff).values({ id: recordId, tenantId: gym.tenantId, userId, branchIds: [branchId], employmentStatus: 'active', specialties: [], certifications: [], commissionRules: [], joinedOn: '2026-01-01', createdAt: at, updatedAt: at }).run();
  return { userId, recordId, email, target: role === 'member' ? { memberId: recordId } : { staffId: recordId } };
}

function request(path: string, body?: unknown, session?: ReturnType<typeof createSession>, headers: Record<string, string> = {}) {
  return app.request(`/v1${path}`, { method: body === undefined ? 'GET' : 'POST', headers: {
    origin, 'content-type': 'application/json', ...(session ? { cookie: `shark_session=${session.token}; shark_csrf=test-csrf`, 'x-csrf-token': 'test-csrf' } : {}), ...headers,
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function issue(target: { memberId: string } | { staffId: string }) {
  const response = await request('/auth/recovery/issue', { ...target, currentPassword: password, identityVerified: true, reason }, owner);
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return await response.json() as Link;
}
function redeem(link: Link, overrides: Record<string, unknown> = {}) {
  return request('/auth/recovery/redeem', { recoveryId: link.recoveryId, token: link.token, password: newPassword, ...overrides });
}
function snapshot() {
  return Object.fromEntries(['users', 'members', 'staff', 'sessions', 'account_recoveries', 'otp_challenges', 'audit_log', 'memberships', 'invoices', 'payments', 'outbox_events']
    .map((table) => [table, sqlite.prepare(`SELECT * FROM ${table} WHERE tenant_id = ? ORDER BY id`).all(gym.tenantId)]));
}

it.each(['member', 'reception'] as const)('recovers an eligible %s with one-use authority, revoking sessions without changing account or membership authority', async (role) => {
  const recipient = account(role);
  const previous = createSession(recipient.userId, gym.tenantId, '127.0.0.1', 'old-device');
  const previous2 = createSession(recipient.userId, gym.tenantId, '127.0.0.1', 'other-device');
  const ticket = issueRealtimeTicket(resolveSession(previous.token)!);
  const beforeUser = db.select().from(schema.users).where(eq(schema.users.id, recipient.userId)).get()!;
  const beforeMembers = sqlite.prepare('SELECT * FROM members WHERE tenant_id = ?').all(gym.tenantId);
  const link = await issue(recipient.target);
  const stored = db.select().from(schema.accountRecoveries).where(eq(schema.accountRecoveries.id, link.recoveryId)).get()!;
  expect(stored.tokenHash).not.toBe(link.token);
  expect(stored.expiresAt - stored.createdAt).toBe(15 * 60_000);
  const response = await redeem(link);
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toEqual({ recovered: true });
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(resolveSession(previous.token)).toBeNull();
  expect(resolveSession(previous2.token)).toBeNull();
  expect(consumeRealtimeTicket(ticket.ticket)).toBeNull();
  expect(resolveSession(owner.token)).not.toBeNull();
  const afterUser = db.select().from(schema.users).where(eq(schema.users.id, recipient.userId)).get()!;
  expect(verifyPassword(newPassword, afterUser.passwordHash!)).toBe(true);
  expect(verifyPassword(password, afterUser.passwordHash!)).toBe(false);
  expect({ ...afterUser, passwordHash: beforeUser.passwordHash, updatedAt: beforeUser.updatedAt }).toEqual(beforeUser);
  expect(sqlite.prepare('SELECT * FROM members WHERE tenant_id = ?').all(gym.tenantId)).toEqual(beforeMembers);
  const auditRows = db.select().from(schema.auditLog).where(and(eq(schema.auditLog.tenantId, gym.tenantId), eq(schema.auditLog.entityId, recipient.userId))).all();
  expect(auditRows.map((row) => row.action)).toEqual(['account.recovery_issued', 'account.recovery_completed']);
  expect(auditRows[0]).toMatchObject({ actorId: gym.ownerId, actorRole: 'owner', reason });
  const auditText = JSON.stringify(auditRows);
  for (const secret of [password, newPassword, link.token, stored.tokenHash, afterUser.passwordHash!]) expect(auditText).not.toContain(secret);
  const after = snapshot();
  expect((await redeem(link)).status).toBe(422);
  expect(snapshot()).toEqual(after);
  expect((await request('/auth/password', { tenantSlug: gym.tenantSlug, email: recipient.email, password })).status).toBe(401);
  expect((await request('/auth/password', { tenantSlug: gym.tenantSlug, email: recipient.email, password: newPassword })).status).toBe(200);
});

it('requires direct owner authority, correct fresh password, verified identity and a reason before any write', async () => {
  const recipient = account();
  const reception = account('reception');
  const desk = createSession(reception.userId, gym.tenantId, '127.0.0.1', 'desk');
  const payload = { ...recipient.target, currentPassword: password, identityVerified: true, reason };
  const cases = [
    { body: payload, session: undefined, status: 401 },
    { body: payload, session: desk, status: 403 },
    { body: { ...payload, currentPassword: 'incorrect-password' }, session: owner, status: 403 },
    { body: { ...payload, identityVerified: false }, session: owner, status: 422 },
    { body: { ...payload, reason: '' }, session: owner, status: 422 },
    { body: { ...payload, role: 'owner' }, session: owner, status: 422 },
  ];
  for (const item of cases) {
    resetRateLimitsForTest();
    const before = snapshot();
    const response = await request('/auth/recovery/issue', item.body, item.session);
    expect(response.status, await response.clone().text()).toBe(item.status);
    expect(snapshot()).toEqual(before);
  }
  const impersonation = createSession(gym.ownerId, gym.tenantId, '127.0.0.1', 'support', 'synthetic-platform');
  const before = snapshot();
  expect((await request('/auth/recovery/issue', payload, impersonation)).status).toBe(403);
  expect(snapshot()).toEqual(before);
});

it('refuses owner/platform, disabled, legal-hold, deleted, first-time and non-employed targets without changes', async () => {
  for (const role of ['owner', 'platform_admin'] as const) {
    const target = account(role);
    const before = snapshot();
    expect((await request('/auth/recovery/issue', { ...target.target, currentPassword: password, identityVerified: true, reason }, owner)).status).toBe(422);
    expect(snapshot()).toEqual(before);
  }
  for (const patch of [{ accountState: 'disabled' }, { accountState: 'legal_hold' }, { accountState: 'invited' }, { deletedAt: Date.now() }, { passwordHash: null }]) {
    resetRateLimitsForTest();
    const target = account();
    db.update(schema.users).set(patch).where(eq(schema.users.id, target.userId)).run();
    const before = snapshot();
    expect((await request('/auth/recovery/issue', { ...target.target, currentPassword: password, identityVerified: true, reason }, owner)).status).toBe(422);
    expect(snapshot()).toEqual(before);
  }
  resetRateLimitsForTest();
  const former = account('trainer');
  db.update(schema.staff).set({ employmentStatus: 'terminated' }).where(eq(schema.staff.id, former.recordId)).run();
  const before = snapshot();
  expect((await request('/auth/recovery/issue', { ...former.target, currentPassword: password, identityVerified: true, reason }, owner)).status).toBe(422);
  expect(snapshot()).toEqual(before);
});

it('enforces tenant and branch scope and prevents recovery from weakening first-time activation', async () => {
  const target = account('member', 'outside-owner-branches');
  const before = snapshot();
  expect((await request('/auth/recovery/issue', { ...target.target, currentPassword: password, identityVerified: true, reason }, owner)).status).toBe(404);
  expect(snapshot()).toEqual(before);
  const own = account();
  db.update(schema.members).set({ tenantId: 'other-tenant' }).where(eq(schema.members.id, own.recordId)).run();
  const other = snapshot();
  expect((await request('/auth/recovery/issue', { ...own.target, currentPassword: password, identityVerified: true, reason }, owner)).status).toBe(404);
  expect(snapshot()).toEqual(other);
  const existing = account();
  expect((await request('/auth/activation/issue', existing.target, owner)).status).toBe(422);
});

it('replaces old handoffs, refuses invalid/expired links and does not consume valid authority on password validation failure', async () => {
  const target = account();
  const first = await issue(target.target); const second = await issue(target.target);
  for (const [link, override] of [[first, {}], [second, { token: 'wrong-token'.repeat(8) }], [second, { password: 'short' }]] as const) {
    const before = snapshot();
    expect((await redeem(link, override)).status).toBe(422);
    expect(snapshot()).toEqual(before);
  }
  db.update(schema.accountRecoveries).set({ expiresAt: Date.now() - 1 }).where(eq(schema.accountRecoveries.id, second.recoveryId)).run();
  const before = snapshot();
  expect((await redeem(second)).status).toBe(422);
  expect(snapshot()).toEqual(before);
  const third = await issue(target.target);
  expect((await redeem(third)).status).toBe(200);
});

it('accepts a private handoff with a stale browser cookie without requiring old-session CSRF', async () => {
  const target = account(); const link = await issue(target.target);
  const response = await request('/auth/recovery/redeem', { recoveryId: link.recoveryId, token: link.token, password: newPassword }, undefined, { cookie: 'shark_session=expired-session' });
  expect(response.status, await response.clone().text()).toBe(200);
});

it('revokes outstanding normalized OTP aliases and activation authority without touching unrelated accounts or tenants', async () => {
  const target = account();
  db.update(schema.users).set({ phone: '+91 98765-43210' }).where(eq(schema.users.id, target.userId)).run();
  const identifiers = [target.email, target.email.toUpperCase(), '+91 98765-43210', '9876543210', '+919876543210', '43210', `activation:${target.userId}`, 'unrelated@recovery.test', '5555555555', `activation:other-${target.userId}`];
  const ids = identifiers.map((identifier) => {
    const challengeId = randomUUID();
    db.insert(schema.otpChallenges).values({ id: challengeId, tenantId: gym.tenantId, identifier, codeHash: 'synthetic-otp-hash', attempts: 0, createdAt: Date.now(), expiresAt: Date.now() + 60_000, consumedAt: null }).run();
    return challengeId;
  });
  const otherTenant = randomUUID();
  db.insert(schema.otpChallenges).values({ id: otherTenant, tenantId: 'other-tenant', identifier: target.email, codeHash: 'synthetic-otp-hash', attempts: 0, createdAt: Date.now(), expiresAt: Date.now() + 60_000, consumedAt: null }).run();
  expect((await redeem(await issue(target.target))).status).toBe(200);
  const consumed = ids.map((challengeId) => db.select().from(schema.otpChallenges).where(eq(schema.otpChallenges.id, challengeId)).get()!.consumedAt !== null);
  expect(consumed).toEqual([true, true, true, true, true, true, true, false, false, false]);
  expect(db.select().from(schema.otpChallenges).where(eq(schema.otpChallenges.id, otherTenant)).get()!.consumedAt).toBeNull();
});

it.each([{ accountState: 'disabled' }, { email: 'changed@recovery.test' }, { role: 'owner' }, { passwordHash: 'credential-changed' }])('rechecks recipient eligibility and identity at redemption: %j', async (patch) => {
  const target = account(); const link = await issue(target.target);
  db.update(schema.users).set(patch).where(eq(schema.users.id, target.userId)).run();
  const before = snapshot();
  expect((await redeem(link)).status).toBe(422);
  expect(snapshot()).toEqual(before);
});

it('refuses a handoff after the owner loses authority and protects initiation/redeem from cross-origin requests', async () => {
  const target = account(); const link = await issue(target.target);
  const before = snapshot();
  const payload = { ...target.target, currentPassword: password, identityVerified: true, reason };
  expect((await request('/auth/recovery/issue', payload, owner, { 'x-csrf-token': 'wrong' })).status).toBe(403);
  expect((await request('/auth/recovery/redeem', { recoveryId: link.recoveryId, token: link.token, password: newPassword }, undefined, { origin: 'https://attacker.invalid' })).status).toBe(403);
  expect(snapshot()).toEqual(before);
  db.update(schema.users).set({ role: 'reception' }).where(eq(schema.users.id, gym.ownerId)).run();
  const changed = snapshot();
  expect((await redeem(link)).status).toBe(422);
  expect(snapshot()).toEqual(changed);
});

it('limits fresh-password guesses by authenticated actor and refuses stale direct helper authority', async () => {
  const target = account();
  for (let attempt = 0; attempt < 5; attempt++) expect((await request('/auth/recovery/issue', { ...target.target, currentPassword: 'wrong', identityVerified: true, reason }, owner)).status).toBe(403);
  expect((await request('/auth/recovery/issue', { ...target.target, currentPassword: password, identityVerified: true, reason }, owner)).status).toBe(429);
  const ctx = resolveSession(owner.token)!;
  db.update(schema.sessions).set({ revokedAt: Date.now() }).where(eq(schema.sessions.id, owner.sessionId)).run();
  const before = snapshot();
  expect(() => requireFreshOwner(ctx, password)).toThrow('Only the gym owner');
  expect(() => issueAccountRecovery(ctx, { ...target.target, currentPassword: password, identityVerified: true, reason })).toThrow('Only the gym owner');
  expect(snapshot()).toEqual(before);
});

it('immediately closes an existing realtime socket after recovery without waiting for another event', async () => {
  const target = account(); const session = createSession(target.userId, gym.tenantId, '127.0.0.1', 'old-realtime');
  const server = createServer(); attachRealtime(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const ticket = issueRealtimeTicket(resolveSession(session.token)!);
  const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/v1/realtime?ticket=${ticket.ticket}`);
  try {
    await once(socket, 'message');
    const closed = once(socket, 'close');
    expect((await redeem(await issue(target.target))).status).toBe(200);
    expect((await closed)[0]).toBe(4401);
  } finally {
    if (socket.readyState !== WebSocket.CLOSED) { socket.close(); await once(socket, 'close'); }
    server.close(); await once(server, 'close');
  }
});
