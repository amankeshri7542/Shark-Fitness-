import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';
import { E2E_ROOT } from './paths';

/**
 * Codes for the demo owner, from the secret global setup enrolled for this run.
 *
 * The server accepts each 30-second code once. Several specs sign the owner
 * in within one step, so this remembers the last step it used and, when that
 * is the current one, waits for the next step to begin rather than relying on
 * the server's clock-drift allowance.
 */
const USED = resolve(E2E_ROOT, '.state/totp-step.json');

function lastStep(): number {
  if (!existsSync(USED)) return 0;
  return (JSON.parse(readFileSync(USED, 'utf8')) as { step: number }).step;
}

export function totpFor(secret: string, timestamp = Date.now()): string {
  return new TOTP({ secret: Secret.fromBase32(secret), algorithm: 'SHA1', digits: 6, period: 30 }).generate({ timestamp });
}

export async function nextOwnerCode(secret = process.env.SHARK_E2E_OWNER_TOTP_SECRET!): Promise<string> {
  const current = Math.floor(Date.now() / 30_000);
  const step = Math.max(current, lastStep() + 1);
  // Start a little into the step, so the code is still current when it is typed.
  const startsAt = step * 30_000 + 500;
  if (startsAt > Date.now() || Date.now() > step * 30_000 + 25_000) {
    const target = Date.now() > step * 30_000 + 25_000 ? startsAt + 30_000 : startsAt;
    await new Promise((done) => setTimeout(done, Math.max(0, target - Date.now())));
  }
  const used = Math.floor(Date.now() / 30_000);
  writeFileSync(USED, JSON.stringify({ step: used }));
  return totpFor(secret);
}

/**
 * Completes the two-step sign-in an API sign-in may owe (P06: owners must use
 * it). Only the seeded owner has a known secret in a run. Returns the CSRF
 * token of the full session. The wait for a fresh code is added to the
 * running test's timeout, as the browser helpers do for the rate limit.
 */
export async function completeApiTwoStep(
  context: APIRequestContext,
  signIn: { csrfToken: string; mfa?: { state?: string } },
): Promise<string> {
  if (signIn.mfa?.state !== 'challenge') return signIn.csrfToken;
  const started = Date.now();
  const code = await nextOwnerCode();
  try {
    test.info().setTimeout(test.info().timeout + (Date.now() - started));
  } catch {
    /* outside a test (global setup): nothing to extend */
  }
  const verified = await context.post('/v1/auth/mfa/verify', { data: { code }, headers: { 'x-csrf-token': signIn.csrfToken } });
  expect(verified.status(), await verified.text()).toBe(200);
  return ((await verified.json()) as { csrfToken: string }).csrfToken;
}
