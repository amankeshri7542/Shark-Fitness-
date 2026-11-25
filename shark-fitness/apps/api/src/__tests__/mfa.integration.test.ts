import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { resetRateLimitsForTest } from '../middleware/index.js';
import { decryptField } from '../lib/field-encryption.js';
import { MINUTE, now } from '../lib/time.js';
import { MFA_MAX_FAILURES, totpCodeFor } from '../services/mfa.js';
import { Browser, addStaff, auditActions, newGym } from './helpers/browser.js';
import { TEST_MFA_SECRET } from './helpers/mfa-secret.js';

/** PRD 04 ENT-IAM-001 and the P06 acceptance criteria for two-step sign-in. */

beforeEach(() => {
  // Each test signs in many times from the same (test) address.
  resetRateLimitsForTest();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Moves the clock only: timers keep running, so the app behaves normally. */
function travel(ms: number): void {
  vi.useFakeTimers({ toFake: ['Date'], now: now() + ms });
}

async function enrolOwner(gym = newGym('mfa')) {
  const browser = new Browser();
  const signIn = await browser.signIn(gym.slug, gym.owner.email, gym.owner.password);
  const started = await browser.json<{ secret: string; uri: string }>('/auth/mfa/enrol/start', { method: 'POST' });
  const confirmed = await browser.json<{ recoveryCodes: string[] }>('/auth/mfa/enrol/confirm', {
    body: { code: totpCodeFor(started.body.secret) },
  });
  expect(confirmed.status).toBe(200);
  return { gym, browser, secret: started.body.secret, recoveryCodes: confirmed.body.recoveryCodes, signIn };
}

/** The next code the factor will accept (the current step may already be spent). */
function nextCode(secret: string): string {
  return totpCodeFor(secret, now() + 30_000);
}

describe('enrolment gate', () => {
  it('gates an owner without MFA to enrolment after sign-in, and nothing else is reachable', async () => {
    const gym = newGym('gate');
    const browser = new Browser();
    const signIn = await browser.signIn(gym.slug, gym.owner.email, gym.owner.password);
    expect(signIn.status).toBe(200);
    expect(signIn.body.mfa.state).toBe('enrol');

    for (const path of ['/admin/dashboard', '/me', '/me/sessions', '/admin/members']) {
      const blocked = await browser.json<{ error: { code: string; details: { state: string } } }>(path);
      expect(blocked.status, path).toBe(401);
      expect(blocked.body.error).toMatchObject({ code: 'MFA_REQUIRED', details: { state: 'enrol' } });
    }
    expect((await browser.request('/me/realtime-ticket', { method: 'POST' })).status).toBe(401);

    const status = await browser.json('/auth/mfa');
    expect(status.body).toMatchObject({ enrolled: false, required: true, requiredBy: 'role', sessionState: 'enrol' });
  });

  it('enrols with a QR URI and manual key, rotates the token and issues ten recovery codes', async () => {
    const gym = newGym('enrol');
    const browser = new Browser();
    await browser.signIn(gym.slug, gym.owner.email, gym.owner.password);
    const partialToken = browser.session;

    const started = await browser.json<{ secret: string; uri: string; issuer: string; account: string }>('/auth/mfa/enrol/start', { method: 'POST' });
    expect(started.status).toBe(200);
    expect(started.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(started.body.uri).toMatch(/^otpauth:\/\/totp\/Shark%20Fitness:/);
    expect(started.body.uri).toContain(`secret=${started.body.secret}`);

    const wrong = await browser.json('/auth/mfa/enrol/confirm', { body: { code: '000000' === totpCodeFor(started.body.secret) ? '111111' : '000000' } });
    expect(wrong.status).toBe(422);

    const confirmed = await browser.json<{ recoveryCodes: string[]; mfa: { state: string } }>('/auth/mfa/enrol/confirm', {
      body: { code: totpCodeFor(started.body.secret) },
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.mfa.state).toBe('verified');
    expect(confirmed.body.recoveryCodes).toHaveLength(10);
    expect(new Set(confirmed.body.recoveryCodes).size).toBe(10);
    expect(browser.session).not.toBe(partialToken);

    expect((await browser.request('/admin/dashboard')).status).toBe(200);
    const stale = new Browser();
    stale.session = partialToken;
    expect((await stale.request('/admin/dashboard')).status).toBe(401);
    expect(auditActions(gym.tenantId, gym.owner.userId)).toContain('auth.mfa_enrolled');
  });

  it('stores the TOTP secret as ciphertext bound to its owner', async () => {
    const { gym, secret } = await enrolOwner();
    const row = db.select().from(schema.userMfa).where(eq(schema.userMfa.userId, gym.owner.userId)).get()!;
    expect(row.secretCiphertext).toMatch(/^v1:[\w-]+:[\w-]+:[\w-]+$/);
    expect(row.secretCiphertext).not.toContain(secret);
    expect(Buffer.from(row.secretCiphertext.split(':')[3]!, 'base64url').toString('utf8')).not.toContain(secret);
    expect(decryptField('mfa-totp', gym.owner.userId, row.secretCiphertext)).toBe(secret);
    // Copied onto another person, it does not decrypt.
    expect(() => decryptField('mfa-totp', 'usr_someone_else', row.secretCiphertext)).toThrow();
    const codes = db.select().from(schema.mfaRecoveryCodes).where(eq(schema.mfaRecoveryCodes.userId, gym.owner.userId)).all();
    expect(codes).toHaveLength(10);
    for (const code of codes) expect(code.codeHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('sign-in challenge', () => {
  it('requires a code after sign-out and sign-in, and accepts each code once', async () => {
    const { gym, browser, secret } = await enrolOwner();
    expect((await browser.request('/auth/sign-out', { method: 'POST' })).status).toBe(200);

    const again = new Browser();
    const signIn = await again.signIn(gym.slug, gym.owner.email, gym.owner.password);
    expect(signIn.body.mfa.state).toBe('challenge');
    const blocked = await again.json<{ error: { code: string; details: { state: string } } }>('/admin/dashboard');
    expect(blocked.body.error).toMatchObject({ code: 'MFA_REQUIRED', details: { state: 'challenge' } });

    const code = nextCode(secret);
    const verified = await again.json<{ mfa: { state: string } }>('/auth/mfa/verify', { body: { code } });
    expect(verified.status).toBe(200);
    expect(verified.body.mfa.state).toBe('verified');
    expect((await again.request('/admin/dashboard')).status).toBe(200);

    // The same code, replayed into another sign-in inside its window.
    const replay = new Browser();
    await replay.signIn(gym.slug, gym.owner.email, gym.owner.password);
    expect((await replay.request('/auth/mfa/verify', { body: { code } })).status).toBe(422);
  });

  it('locks after repeated wrong codes, audits the burst, and unlocks after the lock period', async () => {
    const { gym, secret } = await enrolOwner();
    const browser = new Browser();
    await browser.signIn(gym.slug, gym.owner.email, gym.owner.password);
    const good = nextCode(secret);
    const bad = good === '123456' ? '654321' : '123456';
    for (let attempt = 1; attempt < MFA_MAX_FAILURES; attempt += 1) {
      expect((await browser.request('/auth/mfa/verify', { body: { code: bad } })).status).toBe(422);
    }
    const locked = await browser.request('/auth/mfa/verify', { body: { code: bad } });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(800);
    expect(auditActions(gym.tenantId, gym.owner.userId)).toContain('auth.mfa_locked');
    // Even the right code is refused while locked.
    expect((await browser.request('/auth/mfa/verify', { body: { code: good } })).status).toBe(429);

    travel(16 * MINUTE);
    const later = new Browser();
    await later.signIn(gym.slug, gym.owner.email, gym.owner.password);
    expect((await later.request('/auth/mfa/verify', { body: { code: totpCodeFor(secret) } })).status).toBe(200);
  });

  it('rate-limits the challenge endpoint by IP', async () => {
    const { gym } = await enrolOwner();
    let limited = false;
    for (let attempt = 0; attempt < 12 && !limited; attempt += 1) {
      const browser = new Browser();
      await browser.signIn(gym.slug, gym.owner.email, gym.owner.password);
      const response = await browser.request('/auth/mfa/verify', { body: { code: '000001' } });
      limited = response.status === 429;
    }
    expect(limited).toBe(true);
  });

  it('accepts a recovery code exactly once', async () => {
    const { gym, recoveryCodes } = await enrolOwner();
    const first = new Browser();
    await first.signIn(gym.slug, gym.owner.email, gym.owner.password);
    const used = await first.json<{ recoveryCodesRemaining: number }>('/auth/mfa/verify', {
      body: { recoveryCode: recoveryCodes[0]!.toLowerCase() },
    });
    expect(used.status).toBe(200);
    expect(used.body.recoveryCodesRemaining).toBe(9);

    const second = new Browser();
    await second.signIn(gym.slug, gym.owner.email, gym.owner.password);
    expect((await second.request('/auth/mfa/verify', { body: { recoveryCode: recoveryCodes[0]! } })).status).toBe(422);
    expect(auditActions(gym.tenantId, gym.owner.userId)).toContain('auth.mfa_recovery_code_used');
  });
});

describe('changing a factor', () => {
  it('needs a step-up to disable, and an owner then meets the enrolment gate again', async () => {
    const { gym, browser, secret } = await enrolOwner();
    travel(6 * MINUTE);
    // Keep the session from idling while the clock moves.
    await browser.request('/auth/session/activity', { method: 'POST' });

    const refused = await browser.json<{ error: { code: string; details: { mfa: boolean } } }>('/auth/mfa', { method: 'DELETE' });
    expect(refused.status).toBe(401);
    expect(refused.body.error).toMatchObject({ code: 'STEP_UP_REQUIRED', details: { mfa: true } });

    const noCode = await browser.json<{ error: { fields: Array<{ path: string }> } }>('/auth/step-up', { body: { password: gym.owner.password } });
    expect(noCode.status).toBe(422);
    expect(noCode.body.error.fields[0]?.path).toBe('code');
    expect((await browser.request('/auth/step-up', { body: { password: gym.owner.password, code: nextCode(secret) } })).status).toBe(200);

    const disabled = await browser.json<{ sessionState: string }>('/auth/mfa', { method: 'DELETE' });
    expect(disabled.status).toBe(200);
    expect(disabled.body.sessionState).toBe('enrol');
    expect((await browser.json<{ error: { code: string } }>('/admin/dashboard')).body.error.code).toBe('MFA_REQUIRED');
    expect(db.select().from(schema.userMfa).where(eq(schema.userMfa.userId, gym.owner.userId)).get()).toBeUndefined();
    expect(auditActions(gym.tenantId)).toEqual(expect.arrayContaining(['auth.step_up_required', 'auth.step_up_succeeded', 'auth.mfa_disabled']));
  });

  it('regenerates recovery codes behind a step-up, invalidating the old set', async () => {
    const { gym, browser, recoveryCodes } = await enrolOwner();
    const fresh = await browser.json<{ recoveryCodes: string[] }>('/auth/mfa/recovery-codes', { method: 'POST' });
    expect(fresh.status).toBe(200);
    expect(fresh.body.recoveryCodes).toHaveLength(10);
    const old = new Browser();
    await old.signIn(gym.slug, gym.owner.email, gym.owner.password);
    expect((await old.request('/auth/mfa/verify', { body: { recoveryCode: recoveryCodes[1]! } })).status).toBe(422);
    expect((await old.request('/auth/mfa/verify', { body: { recoveryCode: fresh.body.recoveryCodes[0]! } })).status).toBe(200);
  });
});

describe('who is asked', () => {
  it('gates reception once the gym requires MFA for all staff', async () => {
    const { gym, browser } = await enrolOwner();
    const reception = addStaff(gym.tenantId, [gym.branchId], 'reception');

    const before = new Browser();
    expect((await before.signIn(gym.slug, reception.email, reception.password)).body.mfa.state).toBe('none');

    const updated = await browser.json<{ requireMfaForStaff: boolean }>('/admin/security/settings', {
      method: 'PATCH',
      body: { requireMfaForStaff: true },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.requireMfaForStaff).toBe(true);
    expect(auditActions(gym.tenantId, gym.tenantId)).toContain('settings.security_updated');

    const after = new Browser();
    const signIn = await after.signIn(gym.slug, reception.email, reception.password);
    expect(signIn.body.mfa.state).toBe('enrol');
    expect((await after.json('/auth/mfa')).body).toMatchObject({ required: true, requiredBy: 'gym' });
    expect((await after.request('/admin/dashboard')).status).toBe(401);
  });

  it('never challenges a member, even when the gym requires MFA for staff', async () => {
    const tenant = db.select().from(schema.tenants).where(eq(schema.tenants.slug, 'shark')).get()!;
    const original = tenant.policy;
    db.update(schema.tenants).set({ policy: { ...original, requireMfaForStaff: true } }).where(eq(schema.tenants.id, tenant.id)).run();
    try {
      const member = new Browser();
      const signIn = await member.signIn('shark', 'aman@sharkfitness.in', 'shark1234');
      expect(signIn.body.mfa.state).toBe('none');
      expect((await member.request('/member/home')).status).toBe(200);
      expect((await member.request('/auth/mfa/enrol/start', { method: 'POST' })).status).toBe(412);
    } finally {
      db.update(schema.tenants).set({ policy: original }).where(eq(schema.tenants.id, tenant.id)).run();
    }
  });
});

describe('resets for a lost device', () => {
  it('lets an owner reset a colleague with a reason, never themselves, and signs the colleague out', async () => {
    const { gym, browser } = await enrolOwner();
    const manager = addStaff(gym.tenantId, [gym.branchId], 'regional_manager');
    const managerBrowser = new Browser();
    await managerBrowser.signIn(gym.slug, manager.email, manager.password);
    const started = await managerBrowser.json<{ secret: string }>('/auth/mfa/enrol/start', { method: 'POST' });
    await managerBrowser.request('/auth/mfa/enrol/confirm', { body: { code: totpCodeFor(started.body.secret) } });
    expect((await managerBrowser.request('/admin/dashboard')).status).toBe(200);

    const ownerStaff = db.select().from(schema.staff).where(eq(schema.staff.userId, gym.owner.userId)).get()!;
    const self = await browser.request(`/admin/security/staff/${ownerStaff.id}/mfa/reset`, { body: { reason: 'Lost my own phone' } });
    expect(self.status).toBe(403);

    const tooShort = await browser.request(`/admin/security/staff/${manager.staffId}/mfa/reset`, { body: { reason: 'lost' } });
    expect(tooShort.status).toBe(422);
    const reset = await browser.request(`/admin/security/staff/${manager.staffId}/mfa/reset`, {
      body: { reason: 'Phone stolen; identity checked in person at the desk' },
    });
    expect(reset.status).toBe(200);
    expect((await managerBrowser.request('/admin/dashboard')).status).toBe(401);
    const next = new Browser();
    expect((await next.signIn(gym.slug, manager.email, manager.password)).body.mfa.state).toBe('enrol');
    expect(auditActions(gym.tenantId, manager.userId)).toContain('auth.mfa_reset');

    const list = await browser.json<{ items: Array<{ userId: string; enrolled: boolean; required: boolean }> }>('/admin/security/staff-mfa');
    expect(list.body.items.find((row) => row.userId === manager.userId)).toMatchObject({ enrolled: false, required: true });
    expect(list.body.items.find((row) => row.userId === gym.owner.userId)).toMatchObject({ enrolled: true, required: true });
  });

  it('lets platform support reset an owner, recording it in the gym’s audit log', async () => {
    const { gym } = await enrolOwner();
    const support = new Browser();
    const signIn = await support.signIn('platform', 'support@sharkfitness.io', 'shark1234');
    expect(signIn.body.mfa.state).toBe('challenge');
    db.update(schema.userMfa).set({ lastUsedStep: null }).where(eq(schema.userMfa.userId, signIn.body.viewer.userId)).run();
    expect((await support.request('/auth/mfa/verify', { body: { code: totpCodeFor(TEST_MFA_SECRET) } })).status).toBe(200);

    const reset = await support.request(`/platform/tenants/${gym.tenantId}/users/${gym.owner.userId}/mfa/reset`, {
      body: { reason: 'Owner verified by video call against their ID' },
    });
    expect(reset.status).toBe(200);
    expect(auditActions(gym.tenantId, gym.owner.userId)).toContain('auth.mfa_reset');
    const owner = new Browser();
    expect((await owner.signIn(gym.slug, gym.owner.email, gym.owner.password)).body.mfa.state).toBe('enrol');
  });
});
