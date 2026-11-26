import { expect, request, type APIRequestContext, type Page } from '@playwright/test';
import { DEMO } from './demo';
import { completeApiTwoStep } from './totp';

/** A signed-in API client in its own cookie jar (a second device, or staff). */
export async function apiAs(email: string, password = 'shark1234'): Promise<{ api: APIRequestContext; csrf: string }> {
  const baseURL = process.env.SHARK_E2E_BASE_URL!;
  // Its own client address: another device, as far as rate limits go.
  const address = `10.250.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;
  const api = await request.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL, 'x-forwarded-for': address } });
  const response = await api.post('/v1/auth/password', { data: { tenantSlug: DEMO.gym, email, password } });
  expect(response.status()).toBe(200);
  // The owner owes a TOTP code since P06; members and desk staff do not.
  const csrfToken = await completeApiTwoStep(api, (await response.json()) as { csrfToken: string; mfa?: { state?: string } });
  return { api, csrf: csrfToken };
}

/** Waits until the member app's own worker controls the page (reloading once
 *  if needed: the very first load registers it). */
export async function waitForMemberWorker(page: Page): Promise<string> {
  await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration('/app/'))?.active?.state === 'activated');
  if (!(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null))) await page.reload();
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  return page.evaluate(() => navigator.serviceWorker.controller!.scriptURL);
}

/** Reads a whole IndexedDB object store in the page. */
export async function idbAll<T = unknown>(page: Page, database: string, store: string): Promise<T[]> {
  return page.evaluate(
    ({ database, store }) =>
      new Promise<unknown[]>((resolve, reject) => {
        const open = indexedDB.open(database);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains(store)) {
            db.close();
            resolve([]);
            return;
          }
          const all = db.transaction(store, 'readonly').objectStore(store).getAll();
          all.onsuccess = () => {
            db.close();
            resolve(all.result);
          };
          all.onerror = () => reject(all.error);
        };
      }),
    { database, store },
  ) as Promise<T[]>;
}

/** The signed-in viewer's `tenantId:userId`, the key everything on the device is partitioned by. */
export async function ownerKey(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const response = await fetch('/v1/me', { credentials: 'include' });
    const { viewer } = (await response.json()) as { viewer: { tenantId: string; userId: string } };
    return `${viewer.tenantId}:${viewer.userId}`;
  });
}

/** Puts unsynced writes in this person's outbox, parked so they do not flush. */
export async function parkOutboxEntries(page: Page, owner: string, count: number, kind = 'workout-set'): Promise<void> {
  await page.evaluate(
    ({ owner, count, kind }) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('shark-outbox-v2');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('entries', 'readwrite');
          for (let i = 0; i < count; i += 1) {
            const clientId = `e2e-${kind}-${i}-${Math.random().toString(36).slice(2)}`;
            tx.objectStore('entries').put({
              key: `${owner}:${clientId}`,
              ownerKey: owner,
              clientId,
              kind,
              method: 'POST',
              path: '/member/training/workouts',
              body: {},
              createdAt: Date.now(),
              attempts: 1,
              status: 'failed',
              lastError: 'parked by the test',
              // Far in the future: counted as unsynced, never retried during the test.
              nextAttemptAt: Date.now() + 24 * 60 * 60 * 1000,
            });
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
    { owner, count, kind },
  );
}
