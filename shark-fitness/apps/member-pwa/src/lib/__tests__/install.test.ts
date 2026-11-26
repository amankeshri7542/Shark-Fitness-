import { afterEach, describe, expect, it } from 'vitest';
import { countVisit, installOption, isIos, shouldOfferInstallBanner, visitCount } from '../install';

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('install offer', () => {
  it('never offers the banner on a first visit, and never after it is dismissed', () => {
    expect(shouldOfferInstallBanner(1, 'prompt', false)).toBe(false);
    expect(shouldOfferInstallBanner(2, 'prompt', false)).toBe(true);
    expect(shouldOfferInstallBanner(2, 'ios', false)).toBe(true);
    expect(shouldOfferInstallBanner(5, 'prompt', true)).toBe(false);
    expect(shouldOfferInstallBanner(5, 'installed', false)).toBe(false);
    expect(shouldOfferInstallBanner(5, 'manual', false)).toBe(false);
  });

  it('counts a visit once per browser session', () => {
    expect(countVisit()).toBe(1);
    expect(countVisit()).toBe(1);
    sessionStorage.clear();
    expect(countVisit()).toBe(2);
    expect(visitCount()).toBe(2);
  });

  it('recognises iPhone and iPad (which reports itself as a Mac)', () => {
    expect(isIos('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)', 5)).toBe(true);
    expect(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe(true);
    expect(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe(false);
    expect(isIos('Mozilla/5.0 (Linux; Android 14; Pixel 7)', 5)).toBe(false);
  });

  it('offers the captured browser prompt when there is one', () => {
    const fake = { prompt: async () => undefined, userChoice: Promise.resolve({ outcome: 'accepted' as const }) } as unknown as Event & {
      prompt: () => Promise<void>;
      userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
    };
    expect(installOption({ deferred: fake, installed: false })).toBe('prompt');
    expect(installOption({ deferred: null, installed: true })).toBe('installed');
  });
});
