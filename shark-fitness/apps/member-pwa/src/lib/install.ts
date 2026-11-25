import { create } from 'zustand';

/**
 * "Install app" without nagging (PRD 03; ADR-002).
 *
 * The browser's own install prompt is always held back (we never let it fire
 * on a first visit). The member installs from Profile › More whenever they
 * like, and from the second visit on a one-time banner offers it once.
 * iOS has no install prompt at all, so there the app shows how to add it from
 * the Share menu instead.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface InstallState {
  deferred: BeforeInstallPromptEvent | null;
  installed: boolean;
}

export const useInstall = create<InstallState>(() => ({ deferred: null, installed: false }));

export type InstallOption = 'prompt' | 'ios' | 'installed' | 'manual';

const VISITS_KEY = 'shark.member.visits';
const VISIT_COUNTED_KEY = 'shark.member.visit-counted';
const BANNER_DISMISSED_KEY = 'shark.member.install-banner-dismissed';

export function isStandalone(): boolean {
  const standaloneQuery = typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches;
  return standaloneQuery || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function isIos(userAgent = navigator.userAgent, touchPoints = navigator.maxTouchPoints): boolean {
  // iPadOS reports itself as a Mac; touch support gives it away.
  return /iPad|iPhone|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && touchPoints > 1);
}

/** Start listening as early as possible: the event fires once, at load. */
export function captureInstallPrompt(): void {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    useInstall.setState({ deferred: event as BeforeInstallPromptEvent });
  });
  window.addEventListener('appinstalled', () => useInstall.setState({ deferred: null, installed: true }));
}

export function installOption(state: InstallState = useInstall.getState()): InstallOption {
  if (state.installed || isStandalone()) return 'installed';
  if (state.deferred) return 'prompt';
  if (isIos()) return 'ios';
  return 'manual';
}

export function useInstallOption(): InstallOption {
  const deferred = useInstall((s) => s.deferred);
  const installed = useInstall((s) => s.installed);
  return installOption({ deferred, installed });
}

/** Shows the browser's install dialog. Only from a tap. */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const { deferred } = useInstall.getState();
  if (!deferred) return 'unavailable';
  await deferred.prompt();
  const { outcome } = await deferred.userChoice;
  // A prompt event can be used once.
  useInstall.setState({ deferred: null, installed: outcome === 'accepted' });
  return outcome;
}

/** Counts app opens, once per browser session. Returns the running total. */
export function countVisit(): number {
  try {
    const current = Number(localStorage.getItem(VISITS_KEY) ?? '0') || 0;
    if (sessionStorage.getItem(VISIT_COUNTED_KEY)) return current;
    sessionStorage.setItem(VISIT_COUNTED_KEY, '1');
    localStorage.setItem(VISITS_KEY, String(current + 1));
    return current + 1;
  } catch {
    return 0;
  }
}

export function visitCount(): number {
  try {
    return Number(localStorage.getItem(VISITS_KEY) ?? '0') || 0;
  } catch {
    return 0;
  }
}

export function installBannerDismissed(): boolean {
  try {
    return localStorage.getItem(BANNER_DISMISSED_KEY) === '1';
  } catch {
    return true;
  }
}

export function dismissInstallBanner(): void {
  try {
    localStorage.setItem(BANNER_DISMISSED_KEY, '1');
  } catch {
    /* it simply shows again next time */
  }
}

/** The banner: second visit or later, something to offer, never dismissed. */
export function shouldOfferInstallBanner(visits: number, option: InstallOption, dismissed: boolean): boolean {
  return visits >= 2 && (option === 'prompt' || option === 'ios') && !dismissed;
}
