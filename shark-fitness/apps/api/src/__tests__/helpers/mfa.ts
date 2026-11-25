import { eq } from 'drizzle-orm';
import { app } from '../../app.js';
import { db, schema } from '../../db/client.js';
import { totpCodeFor } from '../../services/mfa.js';

/**
 * The integration suite signs in as owners, regional managers and platform
 * staff hundreds of times. Those roles must use MFA, so `pnpm test` enrols
 * every such seeded account with this test-only secret before Vitest starts
 * (helpers/seed-mfa.ts), and `signInRequest` completes the challenge with a
 * code generated from it.
 *
 * A TOTP code is accepted once (replay protection), and the suite signs in
 * the same owner many times inside one 30-second step. The helper therefore
 * clears the factor's replay marker before each code. That is test set-up,
 * not a bypass: replay refusal itself is proved in mfa.integration.test.ts.
 */
import { TEST_MFA_SECRET } from './mfa-secret.js';

export { TEST_MFA_SECRET };

/** Secrets this test file enrolled through the real API, by user id. */
const enrolledHere = new Map<string, string>();

export function testTotp(userId: string, secret = enrolledHere.get(userId) ?? TEST_MFA_SECRET): string {
  db.update(schema.userMfa).set({ lastUsedStep: null, failedAttempts: 0, lockedUntil: null }).where(eq(schema.userMfa.userId, userId)).run();
  return totpCodeFor(secret);
}

function headerOf(init: RequestInit, name: string): string | undefined {
  const headers = new Headers(init.headers);
  return headers.get(name) ?? undefined;
}

/**
 * `POST /v1/auth/password`, then whatever second step the account owes:
 * the TOTP challenge, or — for an owner of a gym the test just created —
 * enrolment through the real `/auth/mfa/enrol/*` API, exactly as that owner
 * would do it in the console. Answers with the response that carries the
 * *full* session (its cookie and `{ viewer, csrfToken }`), so a caller written
 * before MFA existed reads it exactly as it always did.
 */
export async function signInRequest(init: RequestInit): Promise<Response> {
  return completeSignIn(await app.request('/v1/auth/password', init), init);
}

/** The same second step for any sign-in response (password, OTP, activation). */
export async function completeSignIn(first: Response, init: RequestInit = {}): Promise<Response> {
  if (first.status !== 200) return first;
  const body = (await first.clone().json()) as { viewer: { userId: string }; csrfToken: string; mfa?: { state: string } };
  const state = body.mfa?.state;
  if (state !== 'challenge' && state !== 'enrol') return first;
  const cookie = (first.headers.get('set-cookie') ?? '').match(/shark_session=([^;,]+)/)?.[1];
  const headers = {
    'content-type': 'application/json',
    origin: headerOf(init, 'origin') ?? 'http://localhost:5173',
    cookie: `shark_session=${cookie}; shark_csrf=${body.csrfToken}`,
    'x-csrf-token': body.csrfToken,
    ...(headerOf(init, 'user-agent') ? { 'user-agent': headerOf(init, 'user-agent')! } : {}),
  };
  if (state === 'challenge') {
    return app.request('/v1/auth/mfa/verify', { method: 'POST', headers, body: JSON.stringify({ code: testTotp(body.viewer.userId) }) });
  }
  const started = await app.request('/v1/auth/mfa/enrol/start', { method: 'POST', headers });
  const { secret } = (await started.json()) as { secret: string };
  enrolledHere.set(body.viewer.userId, secret);
  return app.request('/v1/auth/mfa/enrol/confirm', { method: 'POST', headers, body: JSON.stringify({ code: testTotp(body.viewer.userId, secret) }) });
}
