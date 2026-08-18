import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, OfflineError, api, csrf } from '../api';

/** Minimal Response stand-in; api() only reads status and text(). */
function reply(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as Response;
}

const envelope = (code: string, message: string) => ({
  error: { code, message, requestId: 'req_test' },
});

describe('member API client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessionStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('surfaces a failed request as ApiError carrying the server envelope', async () => {
    fetchMock.mockResolvedValueOnce(reply(422, envelope('VALIDATION', 'That is not a valid code.')));

    const failure = await api('/auth/otp/verify', { method: 'POST', body: { code: 'x' } }).catch((e) => e);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(422);
    expect((failure as ApiError).code).toBe('VALIDATION');
    expect((failure as ApiError).requestId).toBe('req_test');
    expect((failure as ApiError).message).toBe('That is not a valid code.');
  });

  it('reports a network failure as OfflineError, not as a server error', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const failure = await api('/me').catch((e) => e);

    // The sign-in screen branches on this to explain that signing in is the
    // one thing that needs a connection, so it must not collapse into ApiError.
    expect(failure).toBeInstanceOf(OfflineError);
    expect(failure).not.toBeInstanceOf(ApiError);
  });

  it('drops the CSRF token when the session is rejected', async () => {
    csrf.set('stale-token');
    fetchMock.mockResolvedValueOnce(reply(401, envelope('UNAUTHENTICATED', 'Sign in again.')));

    await expect(api('/me')).rejects.toBeInstanceOf(ApiError);

    // Keeping a token bound to a dead cookie would make every later write fail.
    expect(csrf.get()).toBeNull();
  });

  it('stores a CSRF token handed back by a successful response', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { viewer: { userId: 'usr_1' }, csrfToken: 'fresh-token' }));

    await api('/auth/password', { method: 'POST', body: { password: 'x' } });

    expect(csrf.get()).toBe('fresh-token');
  });

  it('fetches a CSRF token before an unsafe request that has none', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(200, { csrfToken: 'minted' }))
      .mockResolvedValueOnce(reply(200, { ok: true }));

    await api('/member/workouts', { method: 'POST', body: {} });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/v1/auth/csrf');
    const writeInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect((writeInit.headers as Record<string, string>)['x-csrf-token']).toBe('minted');
  });

  it('refreshes and retries once when a held CSRF token is refused', async () => {
    csrf.set('token-from-another-tab');
    fetchMock
      .mockResolvedValueOnce(reply(403, envelope('CSRF', 'Bad CSRF token.')))
      .mockResolvedValueOnce(reply(200, { csrfToken: 'reissued' }))
      .mockResolvedValueOnce(reply(200, { ok: true }));

    // Signing in on another tab reissues the shared cookie and leaves this tab
    // holding a token the server refuses; without the retry every write here
    // fails until the tab is closed.
    await expect(api('/member/workouts', { method: 'POST', body: {} })).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const retryInit = fetchMock.mock.calls[2]?.[1] as RequestInit;
    expect((retryInit.headers as Record<string, string>)['x-csrf-token']).toBe('reissued');
  });

  it('does not retry a 403 forever when the fresh token is refused too', async () => {
    csrf.set('token');
    fetchMock
      .mockResolvedValueOnce(reply(403, envelope('CSRF', 'Bad CSRF token.')))
      .mockResolvedValueOnce(reply(200, { csrfToken: 'reissued' }))
      .mockResolvedValueOnce(reply(403, envelope('CSRF', 'Bad CSRF token.')));

    await expect(api('/member/workouts', { method: 'POST', body: {} })).rejects.toBeInstanceOf(ApiError);

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not spend a CSRF round trip on a read', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { items: [] }));

    await api('/member/media');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBeUndefined();
    expect(init.credentials).toBe('include');
  });

  it('treats 204 as an empty success rather than parsing a body', async () => {
    csrf.set('token'); // otherwise the write spends its first call minting one
    fetchMock.mockResolvedValueOnce(reply(204, undefined));

    await expect(api('/member/notifications/read', { method: 'POST' })).resolves.toBeUndefined();
  });
});
