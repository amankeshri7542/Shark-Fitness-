import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreditAccount, CreditPackOffer } from '@shark/contracts';
import { api, ApiError, idempotencyKey } from '../../lib/api';
import type { CheckoutTarget } from '../../lib/checkout';
import { Sheet } from '../../ui/Sheet';
import { Button, Chip, Display, Label, Metric, Panel, Seam, SeamCell, SectionRule, type Tone } from '../../ui/primitives';

/**
 * Credits on the member's Billing screen (decision 11, PF-CAT-004/005).
 *
 * Money copy is plain: what you have, when it runs out, what a pack costs,
 * what happens to it if you ask for a refund. Buying raises an invoice; the
 * credits appear when it is paid (online now, or at reception).
 */

const KIND_LABEL = { class: 'Class credits', pt: 'Personal training sessions' } as const;

const PACK_STATE: Record<string, { label: string; tone: Tone }> = {
  pending_payment: { label: 'Waiting for payment', tone: 'warn' },
  active: { label: 'Active', tone: 'good' },
  partially_refunded: { label: 'Part refunded', tone: 'neutral' },
  refunded: { label: 'Refunded', tone: 'neutral' },
  void: { label: 'Cancelled', tone: 'neutral' },
};

function dateLabel(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

interface PurchaseResult {
  invoiceId: string;
  payOnline: boolean;
  creditsAllocated: boolean;
  message: string;
}

export function CreditsPanel({ credits, online, busy, pay }: {
  credits: CreditAccount;
  online: boolean;
  busy: boolean;
  pay: (target: CheckoutTarget) => void;
}) {
  const queryClient = useQueryClient();
  const [buying, setBuying] = useState<CreditPackOffer | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // One key per pack the member is deciding on, so a double tap or a retry
  // after a dropped connection is the same purchase, not a second one.
  const keys = useRef(new Map<string, string>());

  const purchase = useMutation({
    mutationFn: (offer: CreditPackOffer) => {
      const key = keys.current.get(offer.productId) ?? idempotencyKey('pack', offer.productId);
      keys.current.set(offer.productId, key);
      return api<PurchaseResult>('/member/billing/credit-packs', { method: 'POST', body: { productId: offer.productId }, idempotencyKey: key });
    },
    onMutate: () => {
      setNotice(null);
      setFailure(null);
    },
    onSuccess: (result, offer) => {
      keys.current.delete(offer.productId);
      setBuying(null);
      setNotice(result.message);
      void queryClient.invalidateQueries({ queryKey: ['billing'] });
      if (result.payOnline) pay({ kind: 'invoice', invoiceId: result.invoiceId, label: offer.name });
    },
    onError: (error) => setFailure(error instanceof ApiError ? error.message : 'That did not go through. Nothing was bought or charged. Try again.'),
  });

  const offers = credits.offers ?? [];
  const packs = credits.packs ?? [];

  return (
    <>
      <SectionRule>Credits</SectionRule>
      <Seam>
        {credits.balances.map((balance) => (
          <SeamCell key={balance.kind} className="flex-1">
            <Label>{KIND_LABEL[balance.kind]}</Label>
            <div className="mt-1">
              <Metric value={String(balance.usableUnits ?? 0)} size="lg" />
            </div>
            <p className="mt-1 text-[12px] leading-snug text-foam-65">
              {balance.nextExpiry
                ? `${balance.nextExpiry.units} ${balance.nextExpiry.units === 1 ? 'expires' : 'expire'} on ${dateLabel(balance.nextExpiry.on)}`
                : (balance.usableUnits ?? 0) > 0
                  ? 'No expiry date'
                  : 'None to use'}
            </p>
            {balance.warning ? (
              <p role="alert" className="mt-1 text-[12px] leading-snug text-flare">
                {balance.warning}
              </p>
            ) : null}
          </SeamCell>
        ))}
      </Seam>
      <p className="text-[12px] leading-relaxed text-foam-65">
        Credits are used earliest expiry first. Cancel a class before its deadline and the credit comes back with its original
        expiry date. A late cancellation or a missed class uses the credit.
      </p>

      {notice ? (
        <Panel tone="good" className="p-3" role="status">
          <p className="text-[13px] leading-relaxed">{notice}</p>
        </Panel>
      ) : null}
      {failure ? (
        <Panel tone="bad" className="p-3" role="alert">
          <p className="text-[13px] leading-relaxed">{failure}</p>
        </Panel>
      ) : null}

      {packs.length > 0 ? (
        <Seam direction="col">
          {packs.map((pack) => {
            const state = PACK_STATE[pack.state] ?? { label: pack.state.replace(/_/g, ' '), tone: 'neutral' as Tone };
            return (
              <SeamCell key={pack.id}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[14px]">{pack.productName}</div>
                    <div className="mt-0.5 text-[12px] text-foam-65">
                      {pack.state === 'pending_payment'
                        ? `Invoice ${pack.invoiceNumber}. The ${pack.units} credits are added once it is paid.`
                        : `${pack.remaining} of ${pack.units} left${pack.expiresOn ? ` · ${pack.expired ? 'expired' : 'expires'} ${dateLabel(pack.expiresOn)}` : ''}`}
                    </div>
                  </div>
                  <Chip tone={state.tone}>{state.label}</Chip>
                </div>
                {pack.state === 'pending_payment' && pack.dueMinor > 0 && online ? (
                  <Button
                    variant="cta"
                    size="md"
                    className="mt-2.5"
                    disabled={busy}
                    onClick={() => pay({ kind: 'invoice', invoiceId: pack.invoiceId, label: pack.productName })}
                  >
                    Pay {pack.priceLabel} now
                  </Button>
                ) : null}
              </SeamCell>
            );
          })}
        </Seam>
      ) : null}

      {offers.length > 0 ? (
        <div className="flex flex-col gap-2">
          <Label>Buy a pack</Label>
          <Seam direction="col">
            {offers.map((offer) => (
              <SeamCell key={offer.productId}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[14px]">{offer.name}</div>
                    <div className="mt-0.5 text-[12px] text-foam-65">
                      {offer.units} {offer.kind === 'pt' ? 'sessions' : 'credits'} · {offer.perCreditLabel} each · use within {offer.validDays} days
                    </div>
                  </div>
                  <Button variant="outline" size="md" disabled={busy || purchase.isPending} onClick={() => setBuying(offer)} aria-label={`Buy ${offer.name} for ${offer.totalLabel}`}>
                    {offer.totalLabel}
                  </Button>
                </div>
              </SeamCell>
            ))}
          </Seam>
        </div>
      ) : (
        <p className="text-[12px] text-foam-65">{credits.saleUnavailableReason || 'No packs are on sale right now.'}</p>
      )}

      <details className="text-[13px]">
        <summary className="cursor-pointer underline">Credit history</summary>
        <p className="my-2 text-[12px] text-foam-65">{credits.historyNotice}</p>
        {credits.entries.length ? (
          <ul className="flex flex-col gap-2.5">
            {credits.entries.map((entry) => (
              <li key={entry.id} className="border-b border-line-10 pb-2 last:border-b-0">
                <p>
                  <span className="font-display tabular-nums">{entry.delta > 0 ? `+${entry.delta}` : entry.delta}</span>{' '}
                  {entry.kind === 'pt' ? 'PT' : 'class'} · {entry.reason}
                </p>
                <p className="text-[12px] text-foam-65">
                  {dateLabel(entry.createdAt.slice(0, 10))}
                  {entry.expiresOn ? ` · ${entry.expired ? 'expired' : 'expires'} ${dateLabel(entry.expiresOn)}` : ''}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p>No credit activity yet.</p>
        )}
      </details>

      {buying ? (
        <Sheet label={`Buy ${buying.name}`} onClose={() => (purchase.isPending ? undefined : setBuying(null))}>
          <Display size="sm" as="h2">
            Buy {buying.name}?
          </Display>
          <Panel className="mt-3 p-3">
            <Label>Total</Label>
            <div className="mt-1">
              <Metric value={buying.totalLabel} size="md" />
            </div>
            <p className="mt-2 text-[12px] leading-relaxed text-foam-65">
              {buying.units} {buying.kind === 'pt' ? 'personal training sessions' : 'class credits'}, to use within {buying.validDays} days of
              payment. {online ? 'You pay online next; the credits are added when the payment is confirmed.' : 'You pay at reception; the credits are added when they record it.'}
            </p>
            <p className="mt-2 text-[12px] leading-relaxed text-foam-65">
              Refunds: if you have used none, the full amount. If you have used some, the unused credits at {buying.perCreditLabel} each. Expired
              credits are not refundable.
            </p>
          </Panel>
          <div className="mt-3.5 flex gap-2.5">
            <Button variant="cta" size="lg" className="flex-1" disabled={purchase.isPending} onClick={() => purchase.mutate(buying)}>
              {purchase.isPending ? 'Raising the invoice…' : online ? `Continue to pay ${buying.totalLabel}` : 'Raise the invoice'}
            </Button>
            <Button variant="outline" size="lg" disabled={purchase.isPending} onClick={() => setBuying(null)}>
              Not now
            </Button>
          </div>
        </Sheet>
      ) : null}
    </>
  );
}
