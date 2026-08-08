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

const TOKEN_KEY = 'shark.admin.token';

export const auth = {
  get: (): string | null => localStorage.getItem(TOKEN_KEY),
  set: (token: string): void => localStorage.setItem(TOKEN_KEY, token),
  clear: (): void => localStorage.removeItem(TOKEN_KEY),
};

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  branchId?: string | null;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const token = auth.get();
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.branchId) headers['x-branch-id'] = options.branchId;
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;

  let response: Response;
  try {
    response = await fetch(`/v1${path}`, {
      method: options.method ?? 'GET',
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

  if (!response.ok) throw new ApiError(response.status, payload as ErrorEnvelope);
  return payload as T;
}

export function idempotencyKey(scope: string, ...parts: (string | number)[]): string {
  return `${scope}:${parts.join(':')}:${crypto.randomUUID().slice(0, 8)}`;
}
