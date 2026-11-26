import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Sheet } from '../../ui/Sheet';
import { Button, cx, Display, ErrorState, Label, Skeleton } from '../../ui/primitives';

export interface PlanOption {
  productId: string;
  name: string;
  description: string;
  kind: string;
  durationDays: number | null;
  priceLabel: string;
  taxLabel: string;
  totalMinor: number;
  totalLabel: string;
  cancellation: string;
  freezeAllowed: boolean;
}

export interface PlanOptions {
  onlinePayment: boolean;
  mode: 'purchase' | 'renew' | 'unavailable';
  unavailableReason: string | null;
  previousProductId: string | null;
  plans: PlanOption[];
}

const term = (days: number | null) => (days === null ? 'No fixed end date' : days % 30 === 0 && days >= 30 ? `${days / 30} month${days === 30 ? '' : 's'}` : `${days} days`);

/**
 * Choose (or renew) a plan and see exactly what will be charged before any
 * invoice exists: price, GST, total, term and cancellation terms. Confirming
 * creates the invoice and opens payment for it.
 */
export function PlanSheet({
  onClose,
  onConfirm,
  preferredProductId = null,
}: {
  onClose: () => void;
  onConfirm: (plan: PlanOption) => void;
  /** A plan to start on (the website's link); ignored if it is not on offer. */
  preferredProductId?: string | null;
}) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['billing', 'plans'],
    queryFn: () => api<PlanOptions>('/member/billing/plans'),
  });
  const [chosen, setChosen] = useState<string | null>(null);
  const selected = data?.plans.find((plan) => plan.productId === (chosen ?? preferredProductId ?? data.previousProductId)) ?? data?.plans.find((plan) => plan.productId === data.previousProductId) ?? data?.plans[0] ?? null;
  const title = data?.mode === 'renew' ? 'Renew your plan' : 'Choose a plan';

  return (
    <Sheet label={title} onClose={onClose}>
      <Display size="sm" as="h2">{title}</Display>
      {isLoading ? (
        <div className="mt-3 flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : error || !data ? (
        <div className="mt-3">
          <ErrorState title="Could not load plans" body="Nothing has changed. Try again, or ask at reception." onRetry={() => void refetch()} />
        </div>
      ) : data.mode === 'unavailable' ? (
        <p className="mt-2.5 text-[14px] leading-relaxed text-foam-80">{data.unavailableReason}</p>
      ) : data.plans.length === 0 ? (
        <p className="mt-2.5 text-[14px] leading-relaxed text-foam-80">No plans can be bought in the app right now. Reception can set one up for you.</p>
      ) : (
        <>
          <fieldset className="mt-3">
            <legend className="sr-only">Plans</legend>
            <div className="flex flex-col border border-line">
              {data.plans.map((plan) => {
                const active = selected?.productId === plan.productId;
                return (
                  <label
                    key={plan.productId}
                    className={cx('flex min-h-14 cursor-pointer items-center gap-3 border-b border-line px-3 py-2.5 last:border-b-0', active && 'bg-wash-sonar')}
                  >
                    <input
                      type="radio"
                      name="plan"
                      value={plan.productId}
                      checked={active}
                      onChange={() => setChosen(plan.productId)}
                      className="h-5 w-5 accent-[var(--sf-sonar)]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block font-utility text-[15px] font-semibold">{plan.name}</span>
                      <span className="block text-[12px] text-foam-65">{term(plan.durationDays)}</span>
                    </span>
                    <span className="font-display text-[16px] tabular-nums">{plan.totalLabel}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          {selected ? (
            <div className="mt-3 border border-line p-3 text-[13px] leading-relaxed">
              <Label>What you pay</Label>
              <dl className="mt-1.5 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 tabular-nums">
                <dt className="text-foam-65">{selected.name}</dt>
                <dd>{selected.priceLabel}</dd>
                <dt className="text-foam-65">GST</dt>
                <dd>{selected.taxLabel}</dd>
                <dt className="font-semibold">Total today</dt>
                <dd className="font-semibold">{selected.totalLabel}</dd>
              </dl>
              <p className="mt-2 text-foam-80">
                The plan starts today and becomes active once the payment is confirmed. It does not renew or charge you automatically.
              </p>
              {selected.cancellation ? <p className="mt-1.5 text-foam-65">Cancellation: {selected.cancellation}</p> : null}
            </div>
          ) : null}
          <div className="mt-3.5 flex gap-2.5">
            <Button variant="cta" size="lg" className="flex-1" disabled={!selected} onClick={() => selected && onConfirm(selected)}>
              {selected ? `Pay ${selected.totalLabel}` : 'Pay'}
            </Button>
            <Button variant="outline" size="lg" onClick={onClose}>Not now</Button>
          </div>
        </>
      )}
      {data?.mode === 'unavailable' || data?.plans.length === 0 || error ? (
        <div className="mt-3.5">
          <Button variant="outline" size="lg" full onClick={onClose}>Close</Button>
        </div>
      ) : null}
    </Sheet>
  );
}
