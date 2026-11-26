import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreditAccount, CreditPackView } from '@shark/contracts';
import { ApiError, api } from '../../lib/api';
import { usePermission } from '../../lib/store';
import { useIdempotentAttempt } from '../../lib/idempotent-attempt';
import { Button, Chip, EmptyState, ErrorState, Label, Metric, Panel, SelectField, Skeleton, TextAreaField, type Tone } from '../../ui/console';
import { Modal } from '../../ui/overlay';

/**
 * A member's credits on their record (decision 11): balances by lot, packs
 * with what a refund would return today, the full append-only ledger, and the
 * three desk actions — sell a pack, refund one, record a PT session.
 *
 * Money copy is plain, and every amount shown is the server's.
 */

const PACK_STATE: Record<string, { label: string; tone: Tone }> = {
  pending_payment: { label: 'Awaiting payment', tone: 'warn' },
  active: { label: 'Active', tone: 'good' },
  partially_refunded: { label: 'Part refunded', tone: 'neutral' },
  refunded: { label: 'Refunded', tone: 'neutral' },
  void: { label: 'Void', tone: 'neutral' },
};

const KIND = { class: 'Class credits', pt: 'PT sessions' } as const;

export function MemberCredits({ memberId }: { memberId: string }) {
  const canSell = usePermission('billing.record_payment');
  const canRefund = usePermission('billing.refund');
  const canRecordPt = usePermission('member.edit');
  // Coaches see balances and history; prices, invoices and refunds are billing's.
  const canSeeBilling = usePermission('billing.view');
  const client = useQueryClient();
  const [selling, setSelling] = useState(false);
  const [refunding, setRefunding] = useState<CreditPackView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showLedger, setShowLedger] = useState(false);

  const credits = useQuery({
    queryKey: ['member-credits', memberId],
    queryFn: () => api<CreditAccount>(`/admin/billing/members/${memberId}/credits`),
  });

  const refresh = () => {
    for (const key of [['member-credits', memberId], ['member', memberId], ['invoices'], ['billing-summary']]) void client.invalidateQueries({ queryKey: key });
  };

  const ptAttempt = useIdempotentAttempt('pt-session', memberId);
  const recordPt = useMutation({
    mutationFn: () => {
      const body = { note: null };
      return api<{ replayed: boolean }>(`/admin/billing/members/${memberId}/pt-sessions`, { method: 'POST', body, idempotencyKey: ptAttempt.keyFor(body).replace(/[^A-Za-z0-9:_-]/g, '_') });
    },
    onSuccess: () => {
      ptAttempt.retire();
      setNotice('One PT session recorded. One PT credit was used, earliest expiry first.');
      refresh();
    },
    onError: (error) => setNotice(error instanceof ApiError ? error.message : 'That did not go through. Nothing was recorded.'),
  });

  return (
    <Panel title="Credits" className="border-b border-line">
      <div className="flex flex-col gap-3 p-3.5 text-[13px]">
        {credits.isLoading ? (
          <>
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-24 w-full" />
          </>
        ) : credits.error ? (
          <ErrorState title="Could not load credits" body={credits.error.message} onRetry={() => void credits.refetch()} />
        ) : credits.data ? (
          <>
            <div className="flex flex-wrap gap-6">
              {credits.data.balances.map((balance) => (
                <div key={balance.kind} className="min-w-[160px]">
                  <Label>{KIND[balance.kind]}</Label>
                  <div className="mt-1">
                    <Metric value={String(balance.usableUnits ?? 0)} size="md" />
                  </div>
                  <p className="mt-1 text-[12px] text-foam-65">
                    {balance.nextExpiry ? `${balance.nextExpiry.units} expire ${balance.nextExpiry.on}` : (balance.usableUnits ?? 0) > 0 ? 'No expiry' : 'None usable'}
                  </p>
                  {balance.warning ? (
                    <p role="alert" className="mt-1 max-w-[40ch] text-[12px] text-flare">
                      {balance.warning}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>

            <div className="flex flex-wrap gap-2">
              {canSell ? (
                <Button variant="cta" onClick={() => setSelling(true)} disabled={!credits.data.offers?.length}>
                  Sell a pack
                </Button>
              ) : null}
              {canRecordPt ? (
                <Button
                  onClick={() => recordPt.mutate()}
                  pending={recordPt.isPending}
                  pendingLabel="Recording…"
                  disabled={(credits.data.balances.find((b) => b.kind === 'pt')?.usableUnits ?? 0) < 1}
                >
                  Record a PT session
                </Button>
              ) : null}
              <Button variant="ghost" onClick={() => setShowLedger(!showLedger)} aria-expanded={showLedger}>
                {showLedger ? 'Hide ledger' : 'Show ledger'}
              </Button>
            </div>

            {notice ? (
              <p role="status" className="text-[12px] text-foam-80">
                {notice}
              </p>
            ) : null}

            {!canSeeBilling ? null : credits.data.packs?.length ? (
              <ul className="flex flex-col border border-line">
                {credits.data.packs.map((pack) => {
                  const state = PACK_STATE[pack.state] ?? { label: pack.state, tone: 'neutral' as Tone };
                  return (
                    <li key={pack.id} className="flex flex-wrap items-center gap-3 border-b border-line-10 px-3 py-2.5 last:border-b-0">
                      <div className="min-w-[200px] flex-1">
                        <div>{pack.productName}</div>
                        <div className="text-[12px] text-foam-65">
                          {pack.priceLabel} · invoice {pack.invoiceNumber} ·{' '}
                          {pack.state === 'pending_payment'
                            ? `${pack.units} credits on full payment`
                            : `${pack.remaining}/${pack.units} left${pack.expiresOn ? ` · ${pack.expired ? 'expired' : 'expires'} ${pack.expiresOn}` : ''}`}
                        </div>
                      </div>
                      <Chip tone={state.tone}>{state.label}</Chip>
                      {canRefund && pack.state !== 'pending_payment' && pack.state !== 'refunded' ? (
                        <Button onClick={() => setRefunding(pack)} aria-label={`Refund ${pack.productName}`}>
                          Refund
                        </Button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState title="No packs yet" body="Packs sold here or bought in the app appear with their balance, expiry and refund terms." />
            )}

            {showLedger ? (
              <div>
                <p className="mb-2 text-[12px] text-foam-65">{credits.data.historyNotice}</p>
                {credits.data.entries.length ? (
                  <ul className="flex flex-col divide-y divide-line border border-line">
                    {credits.data.entries.map((entry) => (
                      <li key={entry.id} className="flex flex-wrap gap-x-3 px-3 py-2">
                        <span className="w-12 font-display tabular-nums">{entry.delta > 0 ? `+${entry.delta}` : entry.delta}</span>
                        <span className="min-w-[180px] flex-1">
                          {entry.kind === 'pt' ? 'PT' : 'Class'} · {entry.reason}
                        </span>
                        <span className="text-[12px] text-foam-65">
                          {entry.createdAt.slice(0, 10)}
                          {entry.expiresOn ? ` · ${entry.expired ? 'expired' : 'expires'} ${entry.expiresOn}` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>No credit activity yet.</p>
                )}
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      {selling && credits.data ? (
        <SellPackDialog
          memberId={memberId}
          account={credits.data}
          onClose={() => setSelling(false)}
          onDone={(message) => {
            setSelling(false);
            setNotice(message);
            refresh();
          }}
        />
      ) : null}
      {refunding ? (
        <RefundPackDialog
          pack={refunding}
          onClose={() => setRefunding(null)}
          onDone={(message) => {
            setRefunding(null);
            setNotice(message);
            refresh();
          }}
        />
      ) : null}
    </Panel>
  );
}

function SellPackDialog({ memberId, account, onClose, onDone }: {
  memberId: string;
  account: CreditAccount;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const offers = account.offers ?? [];
  const [productId, setProductId] = useState(offers[0]?.productId ?? '');
  const attempt = useIdempotentAttempt('credit-pack', memberId);
  const offer = offers.find((o) => o.productId === productId) ?? null;
  const sell = useMutation({
    mutationFn: () => {
      const body = { productId };
      return api<{ message: string }>(`/admin/billing/members/${memberId}/credit-packs`, { method: 'POST', body, idempotencyKey: attempt.keyFor(body) });
    },
    onSuccess: (result) => {
      attempt.retire();
      onDone(result.message);
    },
  });
  return (
    <Modal
      open
      onClose={() => (sell.isPending ? undefined : onClose())}
      title="Sell a credit pack"
      footer={
        <>
          <Button onClick={onClose} disabled={sell.isPending}>
            Cancel
          </Button>
          <Button variant="cta" onClick={() => sell.mutate()} disabled={!offer} pending={sell.isPending} pendingLabel="Raising invoice…">
            Raise invoice{offer ? ` · ${offer.totalLabel}` : ''}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 p-4 text-[13px]">
        <SelectField
          label="Pack"
          value={productId}
          onChange={(event) => setProductId(event.target.value)}
          options={offers.map((o) => ({ value: o.productId, label: `${o.name} · ${o.totalLabel}` }))}
        />
        {offer ? (
          <p className="leading-relaxed text-foam-80">
            {offer.units} {offer.kind === 'pt' ? 'PT sessions' : 'class credits'} at {offer.perCreditLabel} each, valid {offer.validDays} days
            from payment. This raises an invoice for {offer.totalLabel}; the credits are added the moment it is paid in full.
          </p>
        ) : null}
        {sell.error ? (
          <p role="alert" className="text-chum">
            {sell.error instanceof ApiError ? sell.error.message : 'That did not go through. Nothing was sold.'}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

function RefundPackDialog({ pack, onClose, onDone }: { pack: CreditPackView; onClose: () => void; onDone: (message: string) => void }) {
  const [reason, setReason] = useState('');
  const attempt = useIdempotentAttempt('pack-refund', pack.id);
  const refund = useMutation({
    mutationFn: () => {
      const body = { reason: reason.trim() };
      return api<{ message: string }>(`/admin/billing/credit-packs/${pack.id}/refund`, { method: 'POST', body, idempotencyKey: attempt.keyFor(body) });
    },
    onSuccess: (result) => {
      attempt.retire();
      onDone(result.message);
    },
  });
  const quote = pack.refund;
  return (
    <Modal
      open
      onClose={() => (refund.isPending ? undefined : onClose())}
      title={`Refund ${pack.productName}`}
      footer={
        <>
          <Button onClick={onClose} disabled={refund.isPending}>
            Cancel
          </Button>
          {quote.refundable ? (
            <Button variant="danger" onClick={() => refund.mutate()} disabled={reason.trim().length < 4} pending={refund.isPending} pendingLabel="Refunding…">
              Refund {quote.amountLabel}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="flex flex-col gap-3 p-4 text-[13px]">
        <div className="flex flex-wrap gap-6">
          <div>
            <Label>Paid</Label>
            <div className="mt-1 font-display text-[18px]">{pack.priceLabel}</div>
          </div>
          <div>
            <Label>Unused</Label>
            <div className="mt-1 font-display text-[18px]">
              {pack.remaining}/{pack.units}
            </div>
          </div>
          <div>
            <Label>Refund</Label>
            <div className="mt-1 font-display text-[18px]">{quote.refundable ? quote.amountLabel : 'None'}</div>
          </div>
        </div>
        <p className="leading-relaxed text-foam-80" role={quote.refundable ? undefined : 'alert'}>
          {quote.message}
        </p>
        {quote.refundable ? (
          <TextAreaField
            label="Reason"
            rows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            hint="Required. Recorded against your name with the refund."
          />
        ) : null}
        {refund.error ? (
          <p role="alert" className="text-chum">
            {refund.error instanceof ApiError ? refund.error.message : 'The refund did not go through. No money or credits changed.'}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
