import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAdmin } from '../lib/store';
import { Button } from './console';

/**
 * The support-session banner (PF-PLAT-004).
 *
 * This is the one surface in the console that is *meant* to break the quiet.
 * Everywhere else the design keeps out of the way; here the entire point is
 * that a platform operator cannot forget, for one screen, that the actions
 * they are taking are attributed to somebody else's account inside somebody
 * else's gym. So: full width, above everything including the rail, solid
 * warning fill rather than a tinted wash, and it does not scroll away.
 *
 * The countdown is real. Support access expires on a server clock this session
 * cannot extend, and showing the remaining minutes is what stops an operator
 * discovering it mid-edit. At zero the session is already dead; the banner says
 * so and offers the only thing left, which is to leave.
 */
export function SupportBanner() {
  const impersonation = useAdmin((s) => s.impersonation);
  const signOut = useAdmin((s) => s.signOut);
  const [remaining, setRemaining] = useState(impersonation?.minutesRemaining ?? 0);

  useEffect(() => {
    if (!impersonation) return;
    const tick = (): void => {
      const left = Math.max(0, Math.ceil((Date.parse(impersonation.expiresAt) - Date.now()) / 60_000));
      setRemaining(left);
    };
    tick();
    const timer = setInterval(tick, 20_000);
    return () => clearInterval(timer);
  }, [impersonation]);

  const end = useMutation({
    mutationFn: () => api('/platform/impersonate/end', { method: 'POST' }),
    // Whether the server accepted or the session had already expired, the
    // operator is leaving. Failing to clear locally would strand them in a
    // console they can no longer use.
    onSettled: () => void signOut(),
  });

  if (!impersonation) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-none flex-wrap items-center gap-x-4 gap-y-1.5 bg-flare px-3.5 py-2 text-abyss"
    >
      <span className="font-display text-[13px] uppercase tracking-[0.14em]">Support session</span>
      <p className="min-w-[20ch] flex-1 text-[12px] leading-snug">
        You are <strong className="font-semibold">{impersonation.userName}</strong> at{' '}
        <strong className="font-semibold">{impersonation.tenantName}</strong>. Everything you do here is recorded in
        their audit log as {impersonation.operatorName}.
      </p>
      <span className="font-utility text-[11px] font-semibold uppercase tracking-[0.12em] tabular-nums">
        {remaining > 0 ? `${remaining} min left` : 'Expired'}
      </span>
      <Button
        variant="outline"
        className="!border-abyss !text-abyss hover:!border-abyss hover:!bg-abyss/10 hover:!text-abyss"
        onClick={() => end.mutate()}
        pending={end.isPending}
        pendingLabel="Leaving…"
      >
        Leave this account
      </Button>
    </div>
  );
}
