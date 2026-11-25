/**
 * A full staff session for scripts that drive the API as a person would
 * (backup/restore proof, performance baseline). Owners must use two-step
 * sign-in, so this completes it the way the console does: on a fresh demo
 * database the owner meets the enrolment gate and is enrolled through the API
 * with a newly generated secret, which is remembered for the rest of the run;
 * a later sign-in answers the code challenge with it. Each 30-second code is
 * accepted once, so a second sign-in inside the same step waits for the next.
 */
const secrets = new Map();
const usedSteps = new Map();

async function codeFor(totp, key, secret) {
  let step = Math.floor(Date.now() / 30_000);
  if (usedSteps.get(key) !== undefined && step <= usedSteps.get(key)) {
    await new Promise((done) => setTimeout(done, (usedSteps.get(key) + 1) * 30_000 - Date.now() + 500));
    step = Math.floor(Date.now() / 30_000);
  }
  usedSteps.set(key, step);
  return new totp.TOTP({ secret: totp.Secret.fromBase32(secret), algorithm: 'SHA1', digits: 6, period: 30 }).generate();
}

function sessionFrom(response) {
  return response.headers.get('set-cookie')?.match(/shark_session=([^;,]+)/)?.[1] ?? null;
}

/**
 * @param {string} origin
 * @param {{ tenantSlug: string, email: string, password: string }} credentials
 * @param {(id: string) => any} requireFromApi  resolves `otpauth` from apps/api
 * @returns {Promise<{ session: string, csrfToken: string }>}
 */
export async function staffSession(origin, credentials, requireFromApi) {
  const signIn = await fetch(`${origin}/v1/auth/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(credentials),
  });
  if (!signIn.ok) throw new Error(`Sign-in failed with ${signIn.status}.`);
  let session = sessionFrom(signIn);
  let { csrfToken, mfa } = await signIn.json();
  if (!session) throw new Error('Sign-in did not issue a session.');
  const state = mfa?.state ?? 'none';
  if (state !== 'challenge' && state !== 'enrol') return { session, csrfToken };

  const totp = requireFromApi('otpauth');
  const key = `${credentials.tenantSlug}:${credentials.email}`;
  const post = (path, body) =>
    fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, cookie: `shark_session=${session}; shark_csrf=${csrfToken}`, 'x-csrf-token': csrfToken },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  let completed;
  if (state === 'enrol') {
    const started = await post('/v1/auth/mfa/enrol/start');
    if (!started.ok) throw new Error(`MFA enrolment could not start (${started.status}).`);
    const { secret } = await started.json();
    secrets.set(key, secret);
    completed = await post('/v1/auth/mfa/enrol/confirm', { code: await codeFor(totp, key, secret) });
  } else {
    const secret = secrets.get(key);
    if (!secret) throw new Error(`${credentials.email} has two-step sign-in from elsewhere; this script cannot answer its code.`);
    completed = await post('/v1/auth/mfa/verify', { code: await codeFor(totp, key, secret) });
  }
  if (!completed.ok) throw new Error(`Two-step sign-in failed with ${completed.status}: ${await completed.text()}`);
  session = sessionFrom(completed);
  ({ csrfToken } = await completed.json());
  if (!session) throw new Error('Two-step sign-in did not issue a session.');
  return { session, csrfToken };
}
