import { describe, expect, it } from 'vitest';
import { app } from '../app.js';

const ORIGIN = 'http://localhost:5173';

function signInBody(email = 'aman@sharkfitness.in'): string {
  return JSON.stringify({ tenantSlug: 'shark', email, password: 'shark1234' });
}

async function signIn(): Promise<{ sessionCookie: string; csrfToken: string }> {
  const response = await app.request('/v1/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: signInBody(),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { csrfToken: string };
  const token = (response.headers.get('set-cookie') ?? '').match(/shark_session=([^;,]+)/)?.[1];
  expect(token).toBeTruthy();
  return { sessionCookie: `shark_session=${token}`, csrfToken: body.csrfToken };
}

/**
 * Signing in has to stay reachable from a browser that is still carrying a
 * session cookie. A deployment that recreates its database forgets every
 * session while the cookies survive in the browser, and the client keeps its
 * CSRF token in per-tab sessionStorage — so both are routine, not edge cases.
 */
describe('Signing in with a stale session cookie', () => {
  it('accepts a password sign-in that carries a session cookie but no CSRF token', async () => {
    const { sessionCookie } = await signIn();

    const response = await app.request('/v1/auth/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: sessionCookie },
      body: signInBody(),
    });

    expect(response.status).toBe(200);
  });

  it('accepts a sign-in whose session cookie the server no longer knows', async () => {
    const response = await app.request('/v1/auth/password', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        cookie: 'shark_session=a-session-this-server-has-never-issued',
      },
      body: signInBody(),
    });

    expect(response.status).toBe(200);
  });

  it('issues a fresh CSRF token on that sign-in', async () => {
    const { sessionCookie, csrfToken } = await signIn();

    const response = await app.request('/v1/auth/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: sessionCookie },
      body: signInBody(),
    });

    const body = (await response.json()) as { csrfToken: string };
    expect(body.csrfToken).toBeTruthy();
    expect(body.csrfToken).not.toBe(csrfToken);
    expect(response.headers.get('set-cookie') ?? '').toContain('shark_csrf=');
  });

  it('starts an OTP sign-in while a stale session cookie is present', async () => {
    const response = await app.request('/v1/auth/otp/start', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        cookie: 'shark_session=a-session-this-server-has-never-issued',
      },
      body: JSON.stringify({ tenantSlug: 'shark', identifier: 'aman@sharkfitness.in' }),
    });

    expect(response.status).toBe(200);
  });

  it('still refuses a sign-in from an origin that is not ours', async () => {
    const response = await app.request('/v1/auth/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: signInBody(),
    });

    expect(response.status).toBe(403);
  });

  it('still requires a CSRF token on an authenticated write', async () => {
    const { sessionCookie } = await signIn();

    const response = await app.request('/v1/auth/sign-out', {
      method: 'POST',
      headers: { origin: ORIGIN, cookie: sessionCookie },
    });

    expect(response.status).toBe(403);
  });
});
