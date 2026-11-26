import type { Page } from '@playwright/test';

/**
 * Headless Chromium has no push service to talk to (subscribe() fails without
 * Google's servers), so the page gets a PushManager that hands out a
 * subscription pointing at the local fake push service, with real P-256 keys
 * the test holds the private half of. Everything after subscribe() is real:
 * the app's UI, the API, encryption, VAPID, the fake service receiving it.
 */
export async function stubPushManager(page: Page, subscription: { endpoint: string; keys: { p256dh: string; auth: string } }): Promise<void> {
  await page.addInitScript((sub) => {
    // Survives reloads like a real subscription does.
    const KEY = 'e2e.push-subscribed';
    const make = (): PushSubscription =>
      ({
        endpoint: sub.endpoint,
        expirationTime: null,
        options: { userVisibleOnly: true, applicationServerKey: null },
        getKey: () => null,
        toJSON: () => ({ endpoint: sub.endpoint, expirationTime: null, keys: sub.keys }),
        unsubscribe: async () => {
          sessionStorage.removeItem(KEY);
          return true;
        },
      }) as unknown as PushSubscription;
    PushManager.prototype.subscribe = async function subscribe() {
      sessionStorage.setItem(KEY, '1');
      return make();
    };
    PushManager.prototype.getSubscription = async function getSubscription() {
      return sessionStorage.getItem(KEY) ? make() : null;
    };
  }, subscription);
}
