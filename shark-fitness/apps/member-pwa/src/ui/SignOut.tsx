import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { signOutAndWipe, unsyncedWarning } from '../lib/session';
import { Button, Panel, SectionRule } from './primitives';

/**
 * Sign out of this phone. If anything is still waiting to sync, say what and
 * let the member stay: signing out deletes it from this device.
 */
export function SignOutPanel() {
  const navigate = useNavigate();
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const leave = async (): Promise<void> => {
    setBusy(true);
    try {
      await signOutAndWipe();
      await navigate({ to: '/sign-in' });
    } finally {
      setBusy(false);
    }
  };

  const start = async (): Promise<void> => {
    const unsynced = await unsyncedWarning();
    if (unsynced) setWarning(unsynced);
    else await leave();
  };

  return (
    <div data-testid="sign-out">
      <SectionRule>This phone</SectionRule>
      {warning ? (
        <Panel tone="warn" className="flex flex-col gap-3 p-4" role="alertdialog" aria-labelledby="signout-warning">
          <p id="signout-warning" className="text-[14px] leading-relaxed">
            {warning}. If you sign out now they are deleted from this phone and never reach the gym. Stay signed in
            with a connection for a moment and they upload on their own.
          </p>
          <div className="flex gap-2.5">
            <Button variant="danger" className="flex-1" disabled={busy} onClick={() => void leave()}>
              Sign out anyway
            </Button>
            <Button variant="cta" className="flex-1" disabled={busy} onClick={() => setWarning(null)}>
              Stay
            </Button>
          </div>
        </Panel>
      ) : (
        <Panel className="flex flex-col gap-2 p-4">
          <p className="text-[13px] leading-relaxed text-foam-65">
            Removes your data from this phone, including anything saved for offline use, and stops notifications here.
          </p>
          <Button variant="outline" disabled={busy} onClick={() => void start()}>
            Sign out
          </Button>
        </Panel>
      )}
    </div>
  );
}
