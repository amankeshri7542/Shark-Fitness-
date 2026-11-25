import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { resetRateLimitsForTest } from '../middleware/index.js';
import { DAY, HOUR, MINUTE } from '../lib/time.js';
import { Browser, addStaff, auditActions, newGym } from './helpers/browser.js';
import { hashToken } from '../lib/crypto.js';
import { id, token } from '../lib/ids.js';
import { totpCodeFor } from '../services/mfa.js';
import { testTotp } from './helpers/mfa.js';

/**
 * Server-enforced session lifetimes (PRD 02 "Identity rules", PRD 04 §10.1):
 * staff idle timeout on *user* activity, a 12-hour absolute limit, members on
 * a 30-day sliding session, and the device list.
 */

beforeEach(() => {
  resetRateLimitsForTest();
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => vi.useRealTimers());

const travel = (ms: number) => vi.setSystemTime(Date.now() + ms);

async function owner(): Promise<Browser> {
  const browser = new Browser();
  const signIn = await browser.signIn('shark', 'owner@sharkfitness.in', 'shark1234');
  expect(signIn.body.mfa.state).toBe('challenge');
  expect((await browser.request('/auth/mfa/verify', { body: { code: testTotp(signIn.body.viewer.userId) } })).status).toBe(200);
  return browser;
}

async function endedReason(browser: Browser, path = '/admin/dashboard'): Promise<string | null> {
  const response = await browser.request(path);
  if (response.status === 200) return null;
  expect(response.status).toBe(401);
  const body = (await response.json()) as { error: { code: string; details?: { reason?: string } } };
  expect(body.error.code).toBe('UNAUTHENTICATED');
  return body.error.details?.reason ?? 'unknown';
}

describe('staff idle timeout', () => {
  it('ends a staff session after 30 idle minutes', async () => {
    const browser = await owner();
    travel(29 * MINUTE);
    expect(await endedReason(browser)).toBeNull();
    travel(2 * MINUTE);
    expect(await endedReason(browser)).toBe('idle');
  });

  it('does not count background reads as activity, but counts writes and the heartbeat', async () => {
    const reader = await owner();
    travel(20 * MINUTE);
    expect(await endedReason(reader)).toBeNull(); // a read: allowed, but not activity
    travel(11 * MINUTE);
    expect(await endedReason(reader)).toBe('idle');

    const active = await owner();
    travel(20 * MINUTE);
    const beat = await active.json<{ session: { idleTimeoutSec: number; idleExpiresAt: string } }>('/auth/session/activity', { method: 'POST' });
    expect(beat.status).toBe(200);
    expect(beat.body.session.idleTimeoutSec).toBe(1800);
    expect(Date.parse(beat.body.session.idleExpiresAt)).toBe(Date.now() + 30 * MINUTE);
    travel(20 * MINUTE);
    expect(await endedReason(active)).toBeNull();
    // A write is activity too.
    expect((await active.request('/me/preferences', { method: 'PATCH', body: { theme: 'dark' } })).status).toBe(200);
    travel(25 * MINUTE);
    expect(await endedReason(active)).toBeNull();
  });

  it('uses the gym’s own idle timeout (15–240 minutes)', async () => {
    const gym = newGym('idle');
    const session = new Browser();
    await session.signIn(gym.slug, gym.owner.email, gym.owner.password);
    const started = await session.json<{ secret: string }>('/auth/mfa/enrol/start', { method: 'POST' });
    expect((await session.request('/auth/mfa/enrol/confirm', { body: { code: totpCodeFor(started.body.secret) } })).status).toBe(200);

    expect((await session.request('/admin/security/settings', { method: 'PATCH', body: { staffIdleTimeoutMinutes: 10 } })).status).toBe(422);
    expect((await session.request('/admin/security/settings', { method: 'PATCH', body: { staffIdleTimeoutMinutes: 241 } })).status).toBe(422);
    expect((await session.request('/admin/security/settings', { method: 'PATCH', body: { staffIdleTimeoutMinutes: 90 } })).status).toBe(200);
    travel(80 * MINUTE);
    expect(await endedReason(session)).toBeNull();
    travel(11 * MINUTE);
    expect(await endedReason(session)).toBe('idle');
  });
});

describe('staff absolute lifetime', () => {
  it('ends a staff session 12 hours after sign-in however active it is', async () => {
    const browser = await owner();
    for (let elapsed = 0; elapsed < 12 * HOUR - 25 * MINUTE; elapsed += 25 * MINUTE) {
      travel(25 * MINUTE);
      expect((await browser.request('/auth/session/activity', { method: 'POST' })).status).toBe(200);
    }
    expect(await endedReason(browser)).toBeNull();
    travel(30 * MINUTE);
    expect(await endedReason(browser)).toBe('expired');
  });

  it('applies the 12-hour limit to staff sessions created before it existed', async () => {
    // Sessions written before P06 carry a 30-day expiry and no activity time.
    const ownerRow = db.select().from(schema.users).where(eq(schema.users.email, 'owner@sharkfitness.in')).get()!;
    const legacy = (ageMs: number): Browser => {
      const browser = new Browser();
      browser.session = token();
      const at = Date.now();
      db.insert(schema.sessions)
        .values({
          id: id('ses'), userId: ownerRow.id, tenantId: ownerRow.tenantId, tokenHash: hashToken(browser.session), ip: '127.0.0.1',
          userAgent: browser.userAgent, createdAt: at - ageMs, lastSeenAt: at, lastActiveAt: null, expiresAt: at - ageMs + 30 * DAY,
          revokedAt: null, impersonatorId: null, impersonationExpiresAt: null, mfaState: 'none', reauthenticatedAt: null,
        })
        .run();
      return browser;
    };
    expect(await endedReason(legacy(11 * HOUR))).toBeNull();
    expect(await endedReason(legacy(13 * HOUR))).toBe('expired');
  });

  it('does not extend the 12 hours when two-step sign-in is set up later from Your account', async () => {
    const desk = addStaff(db.select().from(schema.tenants).where(eq(schema.tenants.slug, 'shark')).get()!.id, ['br_kor'], 'branch_manager');
    const browser = new Browser();
    expect((await browser.signIn('shark', desk.email, desk.password)).body.mfa.state).toBe('none');
    travel(11 * HOUR);
    // Kept busy, so only the absolute limit can end it.
    db.update(schema.sessions).set({ lastActiveAt: Date.now() }).where(eq(schema.sessions.userId, desk.userId)).run();
    const started = await browser.json<{ secret: string }>('/auth/mfa/enrol/start', { method: 'POST' });
    expect(started.status).toBe(200);
    expect((await browser.request('/auth/mfa/enrol/confirm', { body: { code: totpCodeFor(started.body.secret) } })).status).toBe(200);
    travel(25 * MINUTE);
    expect((await browser.request('/auth/session/activity', { method: 'POST' })).status).toBe(200);
    travel(25 * MINUTE);
    expect((await browser.request('/auth/session/activity', { method: 'POST' })).status).toBe(200);
    travel(11 * MINUTE);
    expect(await endedReason(browser)).toBe('expired');
  });

  it('gives a half-finished MFA sign-in 15 minutes', async () => {
    const browser = new Browser();
    await browser.signIn('shark', 'owner@sharkfitness.in', 'shark1234');
    travel(16 * MINUTE);
    expect((await browser.request('/auth/mfa/verify', { body: { code: testTotp(db.select().from(schema.users).where(eq(schema.users.email, 'owner@sharkfitness.in')).get()!.id) } })).status).toBe(401);
  });
});

describe('member sessions', () => {
  it('slide for 30 days from last use and never idle out', async () => {
    const member = new Browser();
    const signIn = await member.signIn('shark', 'aman@sharkfitness.in', 'shark1234');
    expect(signIn.body.mfa.state).toBe('none');
    expect(member.session).toBeTruthy();

    travel(29 * DAY);
    expect(await endedReason(member, '/member/home')).toBeNull();
    travel(29 * DAY);
    expect(await endedReason(member, '/member/home')).toBeNull();
    const timing = await member.json<{ session: { kind: string; idleTimeoutSec: number | null } }>('/auth/session');
    expect(timing.body.session).toMatchObject({ kind: 'member', idleTimeoutSec: null });
    travel(31 * DAY);
    expect(await endedReason(member, '/member/home')).toBe('expired');
  });
});

describe('your devices', () => {
  it('lists live sessions with a device label, and revoking one ends it with 401', async () => {
    const laptop = await owner();
    const phone = new Browser('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1');
    const signIn = await phone.signIn('shark', 'owner@sharkfitness.in', 'shark1234');
    expect((await phone.request('/auth/mfa/verify', { body: { code: testTotp(signIn.body.viewer.userId) } })).status).toBe(200);
    // A half-finished sign-in is not a device.
    await new Browser().signIn('shark', 'owner@sharkfitness.in', 'shark1234');

    const list = await laptop.json<{ items: Array<{ id: string; device: string; current: boolean }> }>('/me/sessions');
    const current = list.body.items.find((row) => row.current)!;
    expect(current.device).toBe('Chrome on Windows');
    const other = list.body.items.find((row) => row.device === 'Safari on iOS')!;
    expect(other).toBeDefined();

    expect((await laptop.request(`/me/sessions/${other.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(await endedReason(phone)).toBe('revoked');
    expect(await endedReason(laptop)).toBeNull();
  });

  it('signs out everywhere else and keeps this device', async () => {
    const tenant = db.select().from(schema.tenants).where(eq(schema.tenants.slug, 'shark')).get()!;
    const here = await owner();
    const elsewhere = [await owner(), await owner()];
    const result = await here.json<{ revoked: number }>('/me/sessions/sign-out-others', { method: 'POST' });
    expect(result.status).toBe(200);
    expect(result.body.revoked).toBeGreaterThanOrEqual(2);
    for (const browser of elsewhere) expect(await endedReason(browser)).toBe('revoked');
    expect(await endedReason(here)).toBeNull();
    expect(auditActions(tenant.id)).toContain('session.revoked_all_others');
  });
});
