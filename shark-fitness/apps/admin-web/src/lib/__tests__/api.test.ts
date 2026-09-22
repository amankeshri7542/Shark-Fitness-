import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, csrf } from '../api';
function reply(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) } as Response;
}
const envelope = (code: string, message: string) => ({ error: { code, message, requestId: 'req_test' } });
describe('admin API client activation', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { sessionStorage.clear(); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); });
  it('redeems activation without an existing session or CSRF preflight', async () => {
    const result = { viewer: { userId: 'new-account' }, csrfToken: 'new-session-csrf' };
    fetchMock.mockImplementation(async (url: string) => String(url).endsWith('/auth/csrf')
      ? reply(401, envelope('UNAUTHENTICATED', 'Sign in again.'))
      : reply(200, result));
    const body = { activationId: 'invitation', token: 'synthetic-token', password: 'synthetic-password' };
    await expect(api('/auth/activation/redeem', { method: 'POST', body })).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/v1/auth/activation/redeem');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', credentials: 'include', body: JSON.stringify(body) });
    expect(csrf.get()).toBe('new-session-csrf');
  });
  it('redeems recovery without trying to refresh an expired session first', async () => {
    fetchMock.mockImplementation(async (url: string) => String(url).endsWith('/auth/csrf')
      ? reply(401, envelope('UNAUTHENTICATED', 'Sign in again.')) : reply(200, { recovered: true }));
    const body = { recoveryId: 'recovery', token: 'synthetic-token', password: 'synthetic-password' };
    await expect(api('/auth/recovery/redeem', { method: 'POST', body })).resolves.toEqual({ recovered: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/v1/auth/recovery/redeem');
  });
});
