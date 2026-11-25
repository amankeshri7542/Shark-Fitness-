import { create } from 'zustand';

/**
 * Service worker registration with a held-back update (registerType
 * "prompt").
 *
 * A new build installs in the background and waits. The page offers
 * "Update ready — Reload" (ui/UpdateBar), but only when no workout is running:
 * reloading mid-set would throw the member out of the logger. `applyUpdate`
 * refuses while a workout is active for the same reason, whoever calls it.
 */
interface UpdateState {
  /** The installed-but-waiting worker, when there is one. */
  waiting: ServiceWorker | null;
  registration: ServiceWorkerRegistration | null;
}

export const useServiceWorker = create<UpdateState>(() => ({ waiting: null, registration: null }));

const SCRIPT = '/app/sw.js';
const SCOPE = '/app/';
const HOURLY = 60 * 60 * 1000;

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV || import.meta.env.MODE === 'test') return;
  const start = (): void => void register().catch(() => undefined);
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}

async function register(): Promise<void> {
  const registration = await navigator.serviceWorker.register(SCRIPT, { scope: SCOPE, updateViaCache: 'none' });
  useServiceWorker.setState({ registration });

  const offer = (worker: ServiceWorker | null): void => {
    // Only an *update* waits for permission. With no controller this is the
    // first install, which takes over silently (clients.claim in the worker).
    if (worker && navigator.serviceWorker.controller) useServiceWorker.setState({ waiting: worker });
  };
  offer(registration.waiting);
  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    installing?.addEventListener('statechange', () => {
      if (installing.state === 'installed') offer(registration.waiting ?? installing);
    });
  });

  // Phones keep an installed app open for days: look for a new build when it
  // comes back to the foreground, and hourly while it stays there.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void registration.update().catch(() => undefined);
  });
  window.setInterval(() => void registration.update().catch(() => undefined), HOURLY);
}

/** Activates the waiting worker and reloads once it controls the page.
 *  Returns false (and does nothing) while a workout is active. */
export function applyUpdate(workoutActive: boolean): boolean {
  const { waiting } = useServiceWorker.getState();
  if (!waiting || workoutActive) return false;
  navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true });
  waiting.postMessage({ type: 'SKIP_WAITING' });
  return true;
}
