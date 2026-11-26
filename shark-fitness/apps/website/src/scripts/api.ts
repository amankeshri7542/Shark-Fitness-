/** The public API, same origin. The tenant slug is printed on <body data-tenant> at build. */
export function tenant(): string {
  return document.body.dataset.tenant ?? 'shark';
}

export function publicUrl(path: string): string {
  return `/v1/public/${encodeURIComponent(tenant())}${path}`;
}

export async function getJson<T>(path: string, timeoutMs = 6_000): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(publicUrl(path), { headers: { accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as T;
  } finally {
    window.clearTimeout(timer);
  }
}

/** "Thu 26 Nov". */
export function shortDay(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** "18:30" → "6:30 pm". */
export function clock12(time: string): string {
  const [h = 0, m = 0] = time.split(':').map(Number);
  const suffix = h >= 12 ? 'pm' : 'am';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour} ${suffix}` : `${hour}:${String(m).padStart(2, '0')} ${suffix}`;
}

export const SPOTS_LABEL: Record<string, string> = { available: 'Spaces', few_left: 'Few left', full: 'Full' };
