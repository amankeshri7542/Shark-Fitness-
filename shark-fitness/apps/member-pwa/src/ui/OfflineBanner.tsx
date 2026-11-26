import { useOnline } from '../lib/realtime';
import { useCacheMeta } from '../lib/persisted-cache';

/** 24-hour clock, the member's local time: "07:42". */
export function savedAtLabel(savedAt: number): string {
  return new Date(savedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * Says plainly that what is on screen may be out of date, and how old it is.
 * Writes still work offline (the outbox queues them); reads are the saved copy.
 */
export function OfflineBanner() {
  const online = useOnline();
  const savedAt = useCacheMeta((s) => s.savedAt);
  if (online) return null;
  return (
    <div
      role="status"
      data-testid="offline-banner"
      className="sf-safe-x flex flex-none items-center gap-2 border-b border-flare/35 bg-wash-flare py-2 text-[12px] text-foam-80"
    >
      <span aria-hidden="true" className="font-display text-[13px] leading-none text-flare">
        !
      </span>
      <span>
        {savedAt ? `Offline — showing what was saved at ${savedAtLabel(savedAt)}` : 'Offline — showing what this phone has saved'}
      </span>
    </div>
  );
}
