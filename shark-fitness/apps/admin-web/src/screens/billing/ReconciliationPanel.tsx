import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../../lib/api';
import { usePermission } from '../../lib/store';
import { Button, Chip, ErrorState, Label, Panel, Skeleton } from '../../ui/console';
import { ConfirmDialog } from '../../ui/overlay';

export interface ReconciliationItem {
  id: string;
  kind: string;
  title: string;
  detail: string;
  state: 'open' | 'resolved' | 'ignored';
  invoiceId: string | null;
  invoiceNumber: string | null;
  memberName: string | null;
  providerPaymentId: string | null;
  providerRefundId: string | null;
  expectedLabel: string | null;
  receivedLabel: string | null;
  createdAt: string;
}

interface ReconciliationPayload {
  onlinePayment: boolean;
  items: ReconciliationItem[];
}

export const RECONCILIATION_KEY = ['billing-reconciliation'] as const;

/**
 * Money Razorpay reported that the books could not take as it was: an amount
 * that did not match, a payment for an invoice already settled at the desk, a
 * refund made in the Razorpay Dashboard. Nothing here moves money; staff record
 * what they decided, with a reason, and it is audited (PRD 03 UX-A07).
 */
export function ReconciliationPanel({ onOpenInvoice }: { onOpenInvoice: (invoiceId: string) => void }) {
  const canResolve = usePermission('billing.refund');
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: RECONCILIATION_KEY, queryFn: () => api<ReconciliationPayload>('/admin/billing/reconciliation') });
  const [closing, setClosing] = useState<{ item: ReconciliationItem; action: 'resolve' | 'ignore' } | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const close = useMutation({
    mutationFn: () => api(`/admin/billing/reconciliation/${closing!.item.id}/resolve`, { method: 'POST', body: { action: closing!.action, reason: reason.trim() } }),
    onSuccess: () => {
      setClosing(null);
      setReason('');
      void queryClient.invalidateQueries({ queryKey: RECONCILIATION_KEY });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'That did not work. Try again.'),
  });

  if (query.isLoading) {
    return (
      <Panel title="Reconciliation" className="border-b border-line">
        <div className="flex flex-col gap-2 p-3.5" aria-busy="true">
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
        </div>
      </Panel>
    );
  }
  if (query.error || !query.data) {
    return (
      <Panel title="Reconciliation" className="border-b border-line">
        <div className="p-3.5">
          <ErrorState title="Could not load reconciliation" body="The API did not answer. Nothing has changed." onRetry={() => void query.refetch()} />
        </div>
      </Panel>
    );
  }
  const { items, onlinePayment } = query.data;
  // Without online payment there is nothing to reconcile, and an empty panel is noise.
  if (!onlinePayment && items.length === 0) return null;

  return (
    <Panel title={items.length > 0 ? `Reconciliation · ${items.length} open` : 'Reconciliation'} className="border-b border-line" tone={items.length > 0 ? 'warn' : 'plain'}>
      {items.length === 0 ? (
        <p className="px-3.5 py-2.5 text-[12px] text-foam-65">Nothing to reconcile. Every payment Razorpay reported matched an invoice.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-start justify-between gap-3 px-3.5 py-2.5 text-[12px]">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone="warn">{item.title}</Chip>
                  {item.invoiceId && item.invoiceNumber ? (
                    <button type="button" className="text-left underline underline-offset-2 hover:text-sonar" onClick={() => onOpenInvoice(item.invoiceId!)}>
                      {item.memberName ? `${item.memberName} · ` : ''}{item.invoiceNumber}
                    </button>
                  ) : (
                    <span className="text-foam-65">No matching invoice</span>
                  )}
                </div>
                <p className="mt-1 leading-relaxed text-foam-80">{item.detail}</p>
                <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-foam-65">
                  {item.expectedLabel ? <div className="flex gap-1"><dt>Expected</dt><dd className="tabular-nums text-foam">{item.expectedLabel}</dd></div> : null}
                  {item.receivedLabel ? <div className="flex gap-1"><dt>Received</dt><dd className="tabular-nums text-foam">{item.receivedLabel}</dd></div> : null}
                  {item.providerPaymentId ? <div className="flex gap-1"><dt>Razorpay payment</dt><dd className="select-all text-foam">{item.providerPaymentId}</dd></div> : null}
                  {item.providerRefundId ? <div className="flex gap-1"><dt>Refund</dt><dd className="select-all text-foam">{item.providerRefundId}</dd></div> : null}
                  <div className="flex gap-1"><dt>Seen</dt><dd>{new Date(item.createdAt).toLocaleString('en-IN')}</dd></div>
                </dl>
              </div>
              {canResolve ? (
                <div className="flex gap-1.5">
                  <Button variant="outline" onClick={() => { setError(null); setReason(''); setClosing({ item, action: 'resolve' }); }}>Resolve</Button>
                  <Button variant="ghost" onClick={() => { setError(null); setReason(''); setClosing({ item, action: 'ignore' }); }}>Ignore</Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {items.length > 0 && !canResolve ? (
        <p className="border-t border-line px-3.5 py-2 text-[11px] text-foam-65">
          <Label className="mr-1.5 inline">Read only</Label>Owners and accounts staff resolve these.
        </p>
      ) : null}
      {closing ? (
        <ConfirmDialog
          open
          onClose={() => setClosing(null)}
          onConfirm={() => close.mutate()}
          tone={closing.action === 'resolve' ? 'cta' : 'danger'}
          title={closing.action === 'resolve' ? 'Resolve this exception' : 'Ignore this exception'}
          consequence={
            closing.action === 'resolve'
              ? 'Records that this has been dealt with. Nothing is refunded or charged from here: use Refund or Record payment on the invoice for that.'
              : 'Records that this needs no action. It stays in the audit log with your reason.'
          }
          confirmLabel={closing.action === 'resolve' ? 'Resolve' : 'Ignore'}
          reasonLabel="Reason (required)"
          reason={reason}
          onReasonChange={setReason}
          pending={close.isPending}
          error={error}
        />
      ) : null}
    </Panel>
  );
}
