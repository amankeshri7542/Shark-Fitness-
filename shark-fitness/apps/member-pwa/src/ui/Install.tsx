import { useState } from 'react';
import {
  dismissInstallBanner,
  installBannerDismissed,
  promptInstall,
  shouldOfferInstallBanner,
  useInstallOption,
  visitCount,
} from '../lib/install';
import { Button, Label } from './primitives';
import { Sheet } from './Sheet';

/** How to add the app on iOS, where there is no install button to press. */
export function IosInstallSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet title="Add to Home Screen" onClose={onClose}>
      <ol className="flex flex-col gap-3 text-[14px] leading-relaxed">
        <li className="flex gap-3">
          <span className="font-display text-[18px] leading-none text-sonar">1</span>
          <span>
            Tap <strong>Share</strong> in Safari's toolbar (the square with an arrow pointing up).
          </span>
        </li>
        <li className="flex gap-3">
          <span className="font-display text-[18px] leading-none text-sonar">2</span>
          <span>
            Scroll down and tap <strong>Add to Home Screen</strong>, then <strong>Add</strong>.
          </span>
        </li>
        <li className="flex gap-3">
          <span className="font-display text-[18px] leading-none text-sonar">3</span>
          <span>Open Shark from your Home Screen. Notifications can be turned on from there (iOS 16.4 or later).</span>
        </li>
      </ol>
      <p className="mt-4 text-[12px] leading-relaxed text-foam-50">
        On an iPhone the app is installed from Safari, not the App Store. It is the same app, with your data on our
        servers, not on Apple's.
      </p>
    </Sheet>
  );
}

/**
 * One-time offer to install, from the second visit on. Dismissed for good with
 * one tap; installing hides it too.
 */
export function InstallBanner() {
  const option = useInstallOption();
  const [dismissed, setDismissed] = useState(installBannerDismissed);
  const [showIos, setShowIos] = useState(false);
  if (!shouldOfferInstallBanner(visitCount(), option, dismissed) && !showIos) return null;

  const close = (): void => {
    dismissInstallBanner();
    setDismissed(true);
  };

  return (
    <>
      {!dismissed ? (
        <div data-testid="install-banner" className="flex items-center gap-3 border border-line-accent bg-wash-sonar p-3.5">
          <div className="min-w-0 flex-1">
            <Label className="text-sonar">Install Shark</Label>
            <p className="mt-1 text-[13px] leading-snug text-foam-80">Open it from your home screen, full screen, even offline.</p>
          </div>
          <Button
            variant="cta"
            size="md"
            onClick={() => {
              if (option === 'ios') setShowIos(true);
              else void promptInstall().finally(close);
            }}
          >
            Install
          </Button>
          <button
            type="button"
            onClick={close}
            aria-label="Not now"
            className="grid h-11 w-11 flex-none cursor-pointer place-items-center text-foam-50 hover:text-foam"
          >
            <span aria-hidden="true" className="font-display text-[16px] leading-none">
              ×
            </span>
          </button>
        </div>
      ) : null}
      {showIos ? (
        <IosInstallSheet
          onClose={() => {
            setShowIos(false);
            close();
          }}
        />
      ) : null}
    </>
  );
}
