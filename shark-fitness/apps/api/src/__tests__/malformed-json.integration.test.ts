import { describe, expect, it } from 'vitest';
import { app } from '../app.js';

/* ============================================================================
   A body that is not JSON.

   Found by the Postman suite: a request whose body failed to parse answered
   500 "The team has been notified" on every route that takes JSON, because
   Hono's validator throws its own HTTPException, which the error handler did
   not recognise. A typo in a request is the caller's mistake, and the answer
   should say so in the usual envelope.
   ========================================================================= */

async function ownerSession(): Promise<{ cookie: string; csrfToken: string }> {
  const response = await app.request('/v1/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    body: JSON.stringify({ tenantSlug: 'shark', email: 'owner@sharkfitness.in', password: 'shark1234' }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { csrfToken: string };
  const token = (response.headers.get('set-cookie') ?? '').match(/shark_session=([^;,]+)/)?.[1];
  return { cookie: `shark_session=${token}; shark_csrf=${body.csrfToken}`, csrfToken: body.csrfToken };
}

describe('a malformed JSON body is refused, not a server error', () => {
  it('answers 422 in the error envelope, signed in or not', async () => {
    const owner = await ownerSession();
    const signedIn = { cookie: owner.cookie, origin: 'http://localhost:5173', 'x-csrf-token': owner.csrfToken, 'content-type': 'application/json' };
    for (const [method, path, headers] of [
      ['POST', '/v1/admin/leads', signedIn],
      ['POST', '/v1/admin/billing/invoices/inv_unknown/payments', signedIn],
      ['PATCH', '/v1/admin/settings/business', signedIn],
      ['POST', '/v1/auth/password', { origin: 'http://localhost:5173', 'content-type': 'application/json' }],
    ] as const) {
      const res = await app.request(path, { method, headers, body: '{ "amountMinor": {{due}} }' });
      expect(res.status, path).toBe(422);
      const body = (await res.json()) as { error: { code: string; message: string; requestId: string } };
      expect(body.error.code, path).toBe('VALIDATION_FAILED');
      expect(body.error.message, path).toBe('The request body is not valid JSON.');
      expect(body.error.requestId, path).toBeTruthy();
    }
  });
});
