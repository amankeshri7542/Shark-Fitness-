import type { ErrorEnvelope } from '@shark/contracts';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fields: Array<{ path: string; message: string }>;
  readonly requestId: string;

  constructor(status: number, envelope: ErrorEnvelope) {
    super(envelope.error.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = envelope.error.code;
    this.fields = envelope.error.fields ?? [];
    this.requestId = envelope.error.requestId;
  }
}

export class OfflineError extends Error {
  constructor() {
    super('No connection');
    this.name = 'OfflineError';
  }
}

export const API_ORIGIN = (import.meta.env.VITE_API_ORIGIN ?? '').replace(/\/$/, '');
const CSRF_KEY = 'shark.admin.csrf';

export const csrf = {
  get: (): string | null => {
    try {
      return sessionStorage.getItem(CSRF_KEY);
    } catch {
      return null;
    }
  },
  set: (value: string): void => {
    try {
      sessionStorage.setItem(CSRF_KEY, value);
    } catch {
      /* cookie session remains valid */
    }
  },
  clear: (): void => {
    try {
      sessionStorage.removeItem(CSRF_KEY);
    } catch {
      /* nothing to clear */
    }
  },
};

/** Compatibility shim. There is no bearer credential in localStorage anymore. */
export const auth = {
  get: (): string => 'cookie-session',
  set: (_unused: string): void => undefined,
  clear: (): void => csrf.clear(),
};

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  branchId?: string | null;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_EXEMPT = new Set(['/auth/password', '/auth/otp/start', '/auth/otp/verify']);

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  if (!SAFE_METHODS.has(method) && !CSRF_EXEMPT.has(path) && !csrf.get()) await refreshCsrf();

  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.branchId) headers['x-branch-id'] = options.branchId;
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  const csrfToken = csrf.get();
  if (!SAFE_METHODS.has(method) && csrfToken) headers['x-csrf-token'] = csrfToken;

  let response: Response;
  try {
    response = await fetch(`${API_ORIGIN}/v1${path}`, {
      method,
      headers,
      credentials: 'include',
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch {
    throw new OfflineError();
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    if (response.status === 401) csrf.clear();
    throw new ApiError(response.status, payload as ErrorEnvelope);
  }
  if (payload && typeof payload === 'object' && 'csrfToken' in payload && typeof payload.csrfToken === 'string') {
    csrf.set(payload.csrfToken);
  }
  return payload as T;
}

async function refreshCsrf(): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${API_ORIGIN}/v1/auth/csrf`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'include',
    });
  } catch {
    throw new OfflineError();
  }
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as { csrfToken?: string } | ErrorEnvelope) : null;
  if (!response.ok) {
    if (response.status === 401) csrf.clear();
    throw new ApiError(response.status, payload as ErrorEnvelope);
  }
  if (payload && 'csrfToken' in payload && payload.csrfToken) csrf.set(payload.csrfToken);
}

export function idempotencyKey(scope: string, ...parts: (string | number)[]): string {
  return `${scope}:${parts.join(':')}:${crypto.randomUUID().slice(0, 8)}`;
}
