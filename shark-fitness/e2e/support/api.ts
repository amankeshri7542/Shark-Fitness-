import { expect, request, type APIRequestContext } from '@playwright/test';
import { DEMO } from './demo';

/**
 * A signed-in API session for setting a scene, separate from the browser
 * under test (its own cookie jar). Writes carry the CSRF token, as the apps do.
 */
export interface ApiSession {
  context: APIRequestContext;
  get<T>(path: string): Promise<T>;
  send<T>(method: 'POST' | 'PATCH' | 'PUT', path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: T }>;
  dispose(): Promise<void>;
}

export async function apiSession(baseURL: string, email: string, password = 'shark1234'): Promise<ApiSession> {
  const context = await request.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL } });
  const signIn = await context.post('/v1/auth/password', { data: { tenantSlug: DEMO.gym, email, password } });
  expect(signIn.status(), `sign-in for ${email}`).toBe(200);
  const { csrfToken } = (await signIn.json()) as { csrfToken: string };
  return {
    context,
    async get<T>(path: string) {
      const response = await context.get(path);
      expect(response.status(), `GET ${path}`).toBe(200);
      return (await response.json()) as T;
    },
    async send<T>(method: 'POST' | 'PATCH' | 'PUT', path: string, body?: unknown, headers: Record<string, string> = {}) {
      const response = await context.fetch(path, { method, data: body ?? {}, headers: { 'x-csrf-token': csrfToken, ...headers } });
      return { status: response.status(), body: (await response.json()) as T };
    },
    dispose: () => context.dispose(),
  };
}
