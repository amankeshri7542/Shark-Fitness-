import { describe, expect, it } from 'vitest';
import { app } from '../app.js';

async function signInMember(): Promise<{ cookie: string; csrfToken: string }> {
  const response = await app.request('/v1/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    body: JSON.stringify({ tenantSlug: 'shark', email: 'aman@sharkfitness.in', password: 'shark1234' }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { csrfToken: string };
  const token = (response.headers.get('set-cookie') ?? '').match(/shark_session=([^;,]+)/)?.[1];
  return { cookie: `shark_session=${token}; shark_csrf=${body.csrfToken}`, csrfToken: body.csrfToken };
}

describe('external provider truthfulness', () => {
  it('reports message attachments unavailable and refuses client-supplied file URLs', async () => {
    const session = await signInMember();
    const headers = { cookie: session.cookie, origin: 'http://localhost:5173' };
    const inboxResponse = await app.request('/v1/member/messages', { headers });
    expect(inboxResponse.status).toBe(200);
    const inbox = (await inboxResponse.json()) as {
      attachments: { enabled: boolean; maxSizeMb: number; accept: string[]; reason: string | null };
      items: Array<{ id: string }>;
    };
    expect(inbox.attachments).toMatchObject({ enabled: false, maxSizeMb: 0, accept: [] });
    expect(inbox.attachments.reason).toMatch(/cannot be sent/i);
    expect(inbox.items.length).toBeGreaterThan(0);

    const sendResponse = await app.request(`/v1/member/messages/${inbox.items[0]!.id}`, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        'x-csrf-token': session.csrfToken,
      },
      body: JSON.stringify({
        clientId: 'provider-unavailable-regression',
        body: 'Please see the attachment.',
        attachments: [{ name: 'injury.pdf', url: 'https://files.example/injury.pdf', sizeBytes: 128 }],
      }),
    });
    expect(sendResponse.status).toBe(422);
    expect((await sendResponse.json()) as unknown).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });
});
