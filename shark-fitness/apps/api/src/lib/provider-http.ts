/**
 * One POST to a messaging provider (OTP senders and notification drivers).
 *
 * Never throws: a network error or timeout comes back as status 0, so callers
 * decide between "retry later" and "give up" from one value
 * (`classifyProviderResponse` in @shark/domain). The response text is capped:
 * a provider error page is evidence, not something to store whole.
 */
export interface ProviderResponse {
  /** HTTP status, or 0 when the request never got an answer. */
  status: number;
  /** First 2 KB of the body (or the network error message). */
  text: string;
}

export const PROVIDER_TIMEOUT_MS = 8_000;

export async function providerPost(
  fetchFn: typeof fetch,
  url: string,
  init: Omit<RequestInit, 'method' | 'signal'>,
  timeoutMs = PROVIDER_TIMEOUT_MS,
): Promise<ProviderResponse> {
  let response: Response;
  try {
    response = await fetchFn(url, { ...init, method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { status: 0, text: (error as Error).message.slice(0, 300) };
  }
  const text = await response.text().catch(() => '');
  return { status: response.status, text: text.slice(0, 2_048) };
}

export const basicAuth = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

/** Parses JSON without throwing; `null` for anything that is not an object. */
export function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
