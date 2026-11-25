import { API_ORIGIN } from '../../lib/api';
import type { CheckoutState, CheckoutTarget } from '../../lib/checkout';
import { Button, Label, LiveDot, Panel } from '../../ui/primitives';

/**
 * Where a payment stands, in plain words (payment is a plain-register surface:
 * docs/DESIGN.md "Voice"). Announced politely as it changes; a failure is
 * announced assertively.
 */
export function CheckoutPanel({ state, onRetry, onClose }: {
  state: Exclude<CheckoutState, { phase: 'idle' }>;
  onRetry: (target: CheckoutTarget) => void;
  onClose: () => void;
}) {
  const what = state.target.label;

  if (state.phase === 'opening') {
    return (
      <Panel tone="accent" className="flex items-start gap-3 p-4" role="status" aria-live="polite">
        <LiveDot />
        <div>
          <Label>Opening payment</Label>
          <p className="mt-1 text-[13px] leading-relaxed text-foam-80">Opening the secure Razorpay window for {what}…</p>
        </div>
      </Panel>
    );
  }

  if (state.phase === 'confirming') {
    return (
      <Panel tone="accent" className="flex items-start gap-3 p-4" role="status" aria-live="polite">
        <LiveDot />
        <div>
          <Label>Confirming payment</Label>
          <p className="mt-1 text-[13px] leading-relaxed text-foam-80">
            Checking with Razorpay that the payment for {what} went through. You will not be charged twice.
          </p>
          {state.slow ? (
            <p className="mt-1.5 text-[12px] leading-relaxed text-foam-65">
              The bank is taking longer than usual. You can leave this screen; Billing updates by itself when it is confirmed.
            </p>
          ) : null}
        </div>
      </Panel>
    );
  }

  if (state.phase === 'paid') {
    return (
      <Panel tone="good" className="p-4" role="status" aria-live="polite">
        <div className="flex items-center gap-2 text-kelp">
          <span aria-hidden="true" className="font-display text-[15px]">✓</span>
          <Label className="text-kelp">Paid</Label>
        </div>
        <p className="mt-1.5 text-[13px] leading-relaxed text-foam-80">
          {state.amountLabel ? `${state.amountLabel} received for ${what}.` : `${what} is active.`}
        </p>
        <div className="mt-2.5 flex flex-wrap items-center gap-4 text-[13px]">
          {state.paymentId ? (
            <>
              <a className="underline" href={`${API_ORIGIN}/v1/member/billing/payments/${state.paymentId}/receipt?format=html`} target="_blank" rel="noreferrer">
                View receipt
              </a>
              <a className="underline" href={`${API_ORIGIN}/v1/member/billing/payments/${state.paymentId}/receipt`} download>
                Download receipt
              </a>
            </>
          ) : null}
          <Button variant="ghost" size="sm" onClick={onClose}>Done</Button>
        </div>
      </Panel>
    );
  }

  if (state.phase === 'review') {
    return (
      <Panel tone="warn" className="p-4" role="status" aria-live="polite">
        <Label className="text-flare">Payment received, being checked</Label>
        <p className="mt-1.5 text-[13px] leading-relaxed text-foam-80">
          Razorpay reports a payment for {what} that did not match it exactly, so the gym will check it by hand. Do not pay again; reception will contact you if anything is needed.
        </p>
        <Button className="mt-2" variant="ghost" size="sm" onClick={onClose}>Done</Button>
      </Panel>
    );
  }

  const dismissed = state.phase === 'dismissed';
  return (
    <Panel tone={dismissed ? 'plain' : 'bad'} className="p-4" role={dismissed ? 'status' : 'alert'}>
      <div className={dismissed ? 'text-foam' : 'flex items-center gap-2 text-chum'}>
        {dismissed ? null : <span aria-hidden="true" className="font-display text-[15px]">×</span>}
        <Label className={dismissed ? undefined : 'text-chum'}>{dismissed ? 'Payment not completed' : 'Payment did not go through'}</Label>
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-foam-80">
        {dismissed ? `You closed the payment window. Nothing was charged for ${what}.` : state.reason}
      </p>
      <div className="mt-2.5 flex flex-wrap gap-2.5">
        <Button variant="outline" size="sm" onClick={() => onRetry(state.target)}>Try again</Button>
        <Button variant="ghost" size="sm" onClick={onClose}>Not now</Button>
      </div>
      {dismissed ? null : <p className="mt-2 text-[12px] text-foam-65">You can also pay at reception.</p>}
    </Panel>
  );
}
