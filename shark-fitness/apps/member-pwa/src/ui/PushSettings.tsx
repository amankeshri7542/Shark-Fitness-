import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../lib/api';
import { disablePush, enablePush, fetchPushConfig, pushSupported, thisDeviceSubscription } from '../lib/push';
import { ownerOf } from '../lib/persisted-cache';
import { useViewer } from '../lib/store';
import { Button, Chip, Panel, SectionRule } from './primitives';

/**
 * Phone notifications (PF-COMM-002). Plain register: this is a permission
 * and privacy surface.
 *
 * The browser's permission prompt is only shown after the member has read why
 * we ask and tapped "Allow notifications". Nothing here renders when the
 * gym's server has push switched off or the browser cannot do push.
 */
export function PushSettings() {
  const viewer = useViewer();
  const queryClient = useQueryClient();
  const [rationale, setRationale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const supported = pushSupported();

  const config = useQuery({
    queryKey: ['push-config'],
    queryFn: fetchPushConfig,
    enabled: supported && Boolean(viewer),
    staleTime: 5 * 60_000,
  });

  if (!viewer || !supported || !config.data?.available || !config.data.publicKey) return null;
  const owner = ownerOf(viewer);
  const deviceId = thisDeviceSubscription(owner);
  const enabledHere = Boolean(deviceId && config.data.items.some((item) => item.id === deviceId));
  const blocked = typeof Notification !== 'undefined' && Notification.permission === 'denied';

  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
      await queryClient.invalidateQueries({ queryKey: ['push-config'] });
      await queryClient.invalidateQueries({ queryKey: ['consents'] });
    } catch (error) {
      setProblem(error instanceof ApiError ? error.message : 'That did not go through. Nothing has changed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="push-settings">
      <SectionRule>Phone notifications</SectionRule>
      <Panel className="flex flex-col gap-3 p-4">
        {enabledHere ? (
          <>
            <div className="flex items-center gap-2">
              <Chip tone="good">On for this phone</Chip>
            </div>
            <p className="text-[13px] leading-relaxed text-foam-65">
              Class reminders, booking and waitlist changes, messages from your coach and payment updates arrive here.
            </p>
            <Button variant="outline" disabled={busy} onClick={() => void run(() => disablePush(owner))}>
              Turn off on this phone
            </Button>
          </>
        ) : blocked ? (
          <p className="text-[13px] leading-relaxed text-foam-65">
            Notifications are blocked for this app in your browser or phone settings. Allow them there, then come back
            here to turn them on.
          </p>
        ) : rationale ? (
          <>
            <p className="text-[14px] leading-relaxed">We'll only notify you about things that need you:</p>
            <ul className="flex list-none flex-col gap-1.5 text-[13px] leading-relaxed text-foam-80">
              <li>· a reminder before a class you booked</li>
              <li>· a booking or waitlist change, including a seat that opens up</li>
              <li>· a message from your coach or the front desk</li>
              <li>· a payment that went through or failed</li>
            </ul>
            <p className="text-[12px] leading-relaxed text-foam-50">
              No offers or marketing. Nothing arrives during your gym's quiet hours. Notifications show a title and a
              short line, so anyone who can see your lock screen can read them. Turn them off here at any time.
            </p>
            <div className="flex gap-2.5">
              <Button
                variant="cta"
                className="flex-1"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const result = await enablePush(owner, config.data!.publicKey!);
                    if (result === 'denied') setProblem('Notifications were not allowed. Nothing has changed.');
                    setRationale(false);
                  })
                }
              >
                Allow notifications
              </Button>
              <Button variant="ghost" onClick={() => setRationale(false)}>
                Not now
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-[13px] leading-relaxed text-foam-65">
              Get class reminders, booking changes, coach messages and payment updates on this phone.
            </p>
            <Button variant="outline" onClick={() => setRationale(true)}>
              Turn on notifications
            </Button>
          </>
        )}
        {problem ? (
          <p role="alert" className="text-[12px] text-chum">
            {problem}
          </p>
        ) : null}
      </Panel>
    </div>
  );
}
