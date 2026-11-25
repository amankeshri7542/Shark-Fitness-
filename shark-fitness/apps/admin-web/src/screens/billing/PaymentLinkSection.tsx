import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError, api } from '../../lib/api';
import { useIdempotentAttempt } from '../../lib/idempotent-attempt';
import { Button, Chip, Label, Panel } from '../../ui/console';

export interface PaymentLinkView {
  intentId: string;
  url: string | null;
  state: 'active' | 'paid' | 'expired' | 'superseded' | 'failed' | 'creating';
  expiresAt: string | null;
  amountLabel: string;
  createdByName: string;
  createdAt: string;
}

const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/**
 * Razorpay payment link for an open invoice (PRD 01 §4.6). Staff copy it into
 * whatever conversation they already have with the member: Razorpay is told
 * not to send anything, and neither does this console.
 */
export function PaymentLinkSection({ invoiceId, links, canCreate, payable, onCreated }: {
  invoiceId: string;
  links: PaymentLinkView[];
  canCreate: boolean;
  payable: boolean;
  onCreated: () => void;
}) {
  const [created, setCreated] = useState<PaymentLinkView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const attempt = useIdempotentAttempt('billing-payment-link', invoiceId);
  const create = useMutation({
    mutationFn: () => api<PaymentLinkView>(`/admin/billing/invoices/${invoiceId}/payment-link`, { method: 'POST', idempotencyKey: attempt.keyFor({ invoiceId }) }),
    onMutate: () => setError(null),
    onSuccess: (link) => {
      attempt.retire();
      setCreated(link);
      onCreated();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'The link could not be created. Try again.'),
  });

  const active = (created?.state === 'active' ? created : null) ?? links.find((link) => link.state === 'active') ?? null;
  const past = links.filter((link) => link.intentId !== active?.intentId);

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      setError('Copying is blocked in this browser. Select the link and copy it by hand.');
    }
  };

  return (
    <Panel title="Payment link">
      <div className="flex flex-col gap-2.5 p-3.5 text-[12px]">
        {active?.url ? (
          <>
            <label className="flex flex-col gap-1">
              <Label>Link for {active.amountLabel}</Label>
              <span className="flex">
                <input
                  readOnly
                  value={active.url}
                  onFocus={(event) => event.currentTarget.select()}
                  className="min-h-9 min-w-0 flex-1 border border-line-strong bg-transparent px-2.5 text-[13px] text-foam"
                />
                <Button variant="outline" className="-ml-px" onClick={() => void copy(active.url!)}>
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </span>
            </label>
            <p className="text-foam-65">
              {active.expiresAt ? `Expires ${when(active.expiresAt)}. ` : ''}Created by {active.createdByName}. Nothing has been sent to the member: share it with them yourself.
            </p>
            <span role="status" aria-live="polite" className="sr-only">{copied ? 'Link copied' : ''}</span>
          </>
        ) : payable && canCreate ? (
          <>
            <p className="text-foam-65">Create a Razorpay link the member can pay by UPI, card or netbanking. It is valid for 7 days and settles this invoice when paid. Nothing is sent to the member.</p>
            <Button variant="outline" className="self-start" pending={create.isPending} pendingLabel="Creating…" onClick={() => create.mutate()}>
              Create payment link
            </Button>
          </>
        ) : payable ? (
          <p className="text-foam-65">Staff who record payments can create a link for this invoice.</p>
        ) : (
          <p className="text-foam-65">Nothing is owed on this invoice.</p>
        )}
        {error ? <p role="alert" className="text-chum">{error}</p> : null}
        {past.length > 0 ? (
          <ul className="divide-y divide-line border-t border-line">
            {past.map((link) => (
              <li key={link.intentId} className="flex items-center justify-between gap-2 py-1.5">
                <span className="text-foam-65">{link.amountLabel} · {when(link.createdAt)} · {link.createdByName}</span>
                <Chip tone={link.state === 'paid' ? 'good' : link.state === 'failed' ? 'bad' : 'neutral'}>{link.state}</Chip>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Panel>
  );
}
