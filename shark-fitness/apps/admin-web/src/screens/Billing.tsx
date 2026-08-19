import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api';
import { usePermission } from '../lib/store';
import { Page } from '../ui/shell';
import { Button, Checkbox, Chip, EmptyState, ErrorState, Field, Label, Metric, Panel, PermissionState, Seam, SelectField, Skeleton, Table, TableScroll, type Tone } from '../ui/console';
import { ConfirmDialog, Drawer, Modal } from '../ui/overlay';
import { useIdempotentAttempt } from '../lib/idempotent-attempt';

interface Summary {
  revenueThisMonthLabel: string;
  outstandingLabel: string;
  outstandingInvoiceCount: number;
  overdueCount: number;
  failedPaymentCount: number;
}

interface InvoiceRow {
  id: string;
  number: string;
  state: string;
  issuedOn: string;
  dueOn: string;
  memberId: string;
  memberName: string;
  memberNo: string;
  totalLabel: string;
  dueLabel: string;
}

interface InvoicesPayload {
  total: number;
  items: InvoiceRow[];
  hasMore: boolean;
}

interface InvoiceDetail {
  invoice: {
    id: string;
    number: string;
    state: string;
    issuedOn: string;
    dueOn: string;
    subtotalLabel: string;
    taxLabel: string;
    totalLabel: string;
    paidLabel: string;
    refundedLabel: string;
    dueLabel: string;
    voided: boolean;
    voidReason: string | null;
    memberName: string;
    memberNo: string;
  };
  lines: Array<{ id: string; description: string; quantity: number; unitLabel: string; taxLabel: string; totalLabel: string }>;
  payments: Array<{ id: string; method: string; state: string; amountLabel: string; provider: string | null; failureReason: string | null; recordedByName: string | null; createdAt: string }>;
  refunds: Array<{ id: string; paymentId: string; amountLabel: string; reason: string; entitlementReversed: boolean; actorName: string; createdAt: string }>;
  dunning: Array<{ id: string; attempt: number; channel: string; state: string; scheduledFor: string }>;
}

const STATE_TONE: Record<string, Tone> = {
  open: 'accent',
  partially_paid: 'warn',
  paid: 'good',
  overdue: 'bad',
  void: 'neutral',
  partially_refunded: 'warn',
  refunded: 'neutral',
};

export default function BillingScreen() {
  const canView = usePermission('billing.view');
  const canRecordPayment = usePermission('billing.record_payment');
  const canRefund = usePermission('billing.refund');
  const canWriteOff = usePermission('billing.write_off');
  const queryClient = useQueryClient();
  const [stateFilter, setStateFilter] = useState('');
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(null);

  const summary = useQuery({ queryKey: ['billing-summary'], queryFn: () => api<Summary>('/admin/billing/summary'), enabled: canView });
  const invoices = useQuery({
    queryKey: ['invoices', stateFilter],
    queryFn: () => api<InvoicesPayload>(`/admin/billing/invoices${stateFilter ? `?state=${stateFilter}` : ''}`),
    enabled: canView,
  });
  const dunning = useQuery({ queryKey: ['dunning'], queryFn: () => api<{ items: Array<{ invoiceId: string; number: string; memberName: string; dueLabel: string; attempts: Array<{ attempt: number; channel: string; state: string }> }> }>('/admin/billing/dunning'), enabled: canView });

  if (!canView) {
    return (
      <Page title="Billing">
        <PermissionState what="Billing and reconciliation" />
      </Page>
    );
  }

  if (invoices.isLoading || summary.isLoading) {
    return (
      <Page title="Billing" kicker="Loading">
        <Seam className="border-b border-line">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="min-w-[150px] flex-1 px-3.5 py-3">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="mt-2 h-6 w-24" />
            </div>
          ))}
        </Seam>
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="mx-3.5 my-2 h-9" />
        ))}
      </Page>
    );
  }

  if (invoices.error || !invoices.data || summary.error || !summary.data) {
    return (
      <Page title="Billing">
        <ErrorState title="Could not load billing" body="The API did not answer. Nothing has changed." onRetry={() => { void invoices.refetch(); void summary.refetch(); }} />
      </Page>
    );
  }

  const invalidateAll = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['invoices'] });
    void queryClient.invalidateQueries({ queryKey: ['billing-summary'] });
    void queryClient.invalidateQueries({ queryKey: ['dunning'] });
    if (selectedInvoiceId) void queryClient.invalidateQueries({ queryKey: ['invoice', selectedInvoiceId] });
  };

  return (
    <Page title="Billing" kicker={`${invoices.data.total} invoices`}>
      <Seam className="border-b border-line">
        <div className="min-w-[150px] flex-1 px-3.5 py-3">
          <Label>Revenue this month</Label>
          <div className="mt-1.5">
            <Metric value={summary.data.revenueThisMonthLabel} size="md" tone="good" />
          </div>
        </div>
        <div className="min-w-[150px] flex-1 px-3.5 py-3">
          <Label>Outstanding</Label>
          <div className="mt-1.5">
            <Metric value={summary.data.outstandingLabel} size="md" tone={summary.data.outstandingInvoiceCount > 0 ? 'warn' : 'default'} />
          </div>
        </div>
        <div className="min-w-[150px] flex-1 px-3.5 py-3">
          <Label>Overdue</Label>
          <div className="mt-1.5">
            <Metric value={summary.data.overdueCount} size="md" tone={summary.data.overdueCount > 0 ? 'bad' : 'default'} />
          </div>
        </div>
        <div className="min-w-[150px] flex-1 px-3.5 py-3">
          <Label>Failed payments (30d)</Label>
          <div className="mt-1.5">
            <Metric value={summary.data.failedPaymentCount} size="md" tone={summary.data.failedPaymentCount > 0 ? 'bad' : 'default'} />
          </div>
        </div>
      </Seam>

      {dunning.data && dunning.data.items.length > 0 ? (
        <Panel title={`Dunning queue · ${dunning.data.items.length}`} className="border-b border-line" tone="warn">
          <ul className="flex flex-col divide-y divide-line">
            {dunning.data.items.map((d) => (
              <li key={d.invoiceId} className="flex items-center justify-between gap-2 px-3.5 py-2 text-[12px]">
                <button type="button" className="text-left hover:text-sonar" onClick={() => setSelectedInvoiceId(d.invoiceId)}>
                  {d.memberName} · {d.number}
                </button>
                <span className="text-foam-45">
                  {d.dueLabel} · attempt {d.attempts.at(-1)?.attempt ?? 0} ({d.attempts.at(-1)?.state})
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <div className="border-b border-line p-3.5">
        <div className="flex flex-col gap-1">
          <Label>State</Label>
          <div className="flex flex-wrap">
            {['', 'open', 'partially_paid', 'overdue', 'paid', 'void', 'refunded'].map((s, i) => (
              <button
                key={s || 'all'}
                type="button"
                onClick={() => setStateFilter(s)}
                aria-pressed={stateFilter === s}
                className={`min-h-9 border border-line px-2.5 font-utility text-[10px] font-semibold uppercase tracking-[0.1em] transition-colors ${i > 0 ? '-ml-px' : ''} ${stateFilter === s ? 'z-10 border-sonar text-sonar' : 'text-foam-45 hover:text-foam'}`}
              >
                {s || 'all'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {invoices.data.hasMore ? (
        <Panel tone="warn" className="border-b border-line">
          <p className="px-3.5 py-2.5 text-[12px] leading-relaxed">
            Showing {invoices.data.items.length} of {invoices.data.total} invoices. Filter by state to narrow the list.
          </p>
        </Panel>
      ) : null}

      {invoices.data.items.length === 0 ? (
        <EmptyState title="No invoices" body="Nothing matches that filter yet." />
      ) : (
        <TableScroll><Table>
          <thead>
            <tr>
              <th>Invoice</th>
              <th>Member</th>
              <th>State</th>
              <th>Issued</th>
              <th className="text-right">Total</th>
              <th className="text-right">Due</th>
            </tr>
          </thead>
          <tbody>
            {invoices.data.items.map((inv) => (
              <tr key={inv.id} onClick={() => setSelectedInvoiceId(inv.id)} className="cursor-pointer">
                <td className="font-utility text-[11px] uppercase tracking-[0.08em]">{inv.number}</td>
                <td>
                  {inv.memberName} <span className="text-foam-35">· {inv.memberNo}</span>
                </td>
                <td>
                  <Chip tone={STATE_TONE[inv.state] ?? 'neutral'}>{inv.state.replace(/_/g, ' ')}</Chip>
                </td>
                <td className="text-[12px] text-foam-65">{inv.issuedOn}</td>
                <td data-numeric className="font-display text-[13px]">
                  {inv.totalLabel}
                </td>
                <td data-numeric className="font-display text-[13px] text-chum">
                  {inv.dueLabel}
                </td>
              </tr>
            ))}
          </tbody>
        </Table></TableScroll>
      )}

      {selectedInvoiceId ? (
        <InvoiceDetailPanel
          invoiceId={selectedInvoiceId}
          canRecordPayment={canRecordPayment}
          canRefund={canRefund}
          canWriteOff={canWriteOff}
          onClose={() => setSelectedInvoiceId(null)}
          onChanged={invalidateAll}
        />
      ) : null}
    </Page>
  );
}

function InvoiceDetailPanel({
  invoiceId,
  canRecordPayment,
  canRefund,
  canWriteOff,
  onClose,
  onChanged,
}: {
  invoiceId: string;
  canRecordPayment: boolean;
  canRefund: boolean;
  canWriteOff: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [sheet, setSheet] = useState<'payment' | 'void' | { refundPaymentId: string } | null>(null);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['invoice', invoiceId], queryFn: () => api<InvoiceDetail>(`/admin/billing/invoices/${invoiceId}`) });

  return (
    <Drawer open onClose={onClose} kicker="Invoice" title={data?.invoice.number ?? 'Invoice'}>
      <>
        {isLoading ? (
          <Skeleton className="m-4 h-64" />
        ) : error || !data ? (
          <div className="p-4">
            <ErrorState title="Could not load this invoice" body="The API did not answer." onRetry={() => void refetch()} />
          </div>
        ) : (
          <>
            <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
              <Chip tone={STATE_TONE[data.invoice.state] ?? 'neutral'}>{data.invoice.state.replace(/_/g, ' ')}</Chip>
            </header>

            <div className="flex flex-col gap-3.5 p-4">
              <Panel title="Summary">
                <div className="grid grid-cols-2 gap-3 p-3.5 text-[13px]">
                  <div>
                    <Label>Member</Label>
                    <div className="mt-1">
                      {data.invoice.memberName} · {data.invoice.memberNo}
                    </div>
                  </div>
                  <div>
                    <Label>Due</Label>
                    <div className="mt-1 text-chum">{data.invoice.dueLabel}</div>
                  </div>
                  <div>
                    <Label>Total / Paid</Label>
                    <div className="mt-1">
                      {data.invoice.totalLabel} / {data.invoice.paidLabel}
                    </div>
                  </div>
                  <div>
                    <Label>Refunded</Label>
                    <div className="mt-1">{data.invoice.refundedLabel}</div>
                  </div>
                </div>
                {data.invoice.voided ? <p className="border-t border-line px-3.5 py-2.5 text-[12px] text-foam-45">Voided: {data.invoice.voidReason}</p> : null}
              </Panel>

              <Panel title="Lines">
                <ul className="divide-y divide-line">
                  {data.lines.map((l) => (
                    <li key={l.id} className="flex items-center justify-between px-3.5 py-2 text-[12px]">
                      <span>{l.description}</span>
                      <span className="font-display">{l.totalLabel}</span>
                    </li>
                  ))}
                </ul>
              </Panel>

              {!data.invoice.voided && data.invoice.state !== 'paid' && data.invoice.state !== 'refunded' ? (
                <div className="flex flex-wrap gap-2">
                  {canRecordPayment ? (
                    <Button variant="cta" onClick={() => setSheet('payment')}>
                      Record payment
                    </Button>
                  ) : null}
                  {canWriteOff && data.payments.every((p) => p.state !== 'succeeded') ? (
                    <Button variant="danger" onClick={() => setSheet('void')}>
                      Void
                    </Button>
                  ) : null}
                </div>
              ) : null}

              <Panel title="Payments">
                {data.payments.length === 0 ? (
                  <p className="p-3.5 text-[12px] text-foam-45">No payment attempts yet.</p>
                ) : (
                  <ul className="divide-y divide-line">
                    {data.payments.map((p) => (
                      <li key={p.id} className="flex items-center justify-between gap-2 px-3.5 py-2 text-[12px]">
                        <div>
                          <div>
                            {p.method} · <Chip tone={p.state === 'succeeded' ? 'good' : p.state === 'failed' ? 'bad' : 'neutral'}>{p.state}</Chip>
                          </div>
                          <div className="mt-0.5 text-foam-45">{p.recordedByName ?? p.provider ?? '—'}</div>
                          {p.failureReason ? <div className="mt-0.5 text-chum">{p.failureReason}</div> : null}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="font-display">{p.amountLabel}</span>
                          {canRefund && p.state === 'succeeded' ? (
                            <Button variant="outline" onClick={() => setSheet({ refundPaymentId: p.id })}>
                              Refund
                            </Button>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>

              {data.refunds.length > 0 ? (
                <Panel title="Refunds">
                  <ul className="divide-y divide-line">
                    {data.refunds.map((r) => (
                      <li key={r.id} className="px-3.5 py-2 text-[12px]">
                        <div className="flex items-center justify-between">
                          <span>{r.reason}</span>
                          <span className="font-display">{r.amountLabel}</span>
                        </div>
                        <div className="mt-0.5 text-foam-45">
                          {r.actorName} · {r.entitlementReversed ? 'entitlement reversed' : 'entitlement kept'}
                        </div>
                      </li>
                    ))}
                  </ul>
                </Panel>
              ) : null}

              {data.dunning.length > 0 ? (
                <Panel title="Dunning history">
                  <ul className="divide-y divide-line">
                    {data.dunning.map((d) => (
                      <li key={d.id} className="flex items-center justify-between px-3.5 py-2 text-[12px]">
                        <span>
                          Attempt {d.attempt} · {d.channel}
                        </span>
                        <Chip tone={d.state === 'sent' ? 'good' : d.state === 'failed' ? 'bad' : 'neutral'}>{d.state}</Chip>
                      </li>
                    ))}
                  </ul>
                </Panel>
              ) : null}
            </div>
          </>
        )}
      </>

      {sheet === 'payment' && data ? (
        <RecordPaymentSheet invoiceId={invoiceId} dueLabel={data.invoice.dueLabel} onClose={() => setSheet(null)} onDone={() => { setSheet(null); onChanged(); void refetch(); }} />
      ) : null}
      {sheet === 'void' ? <VoidSheet invoiceId={invoiceId} onClose={() => setSheet(null)} onDone={() => { setSheet(null); onChanged(); void refetch(); }} /> : null}
      {sheet && typeof sheet === 'object' ? (
        <RefundSheet paymentId={sheet.refundPaymentId} onClose={() => setSheet(null)} onDone={() => { setSheet(null); onChanged(); void refetch(); }} />
      ) : null}
    </Drawer>
  );
}

function RecordPaymentSheet({ invoiceId, dueLabel, onClose, onDone }: { invoiceId: string; dueLabel: string; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);

  /* Money in. This endpoint takes its key in the body, so the fingerprint is
     the payment's identity and the key it mints is placed inside the body that
     gets sent. A retry after a lost response must not take the money twice. */
  const attempt = useIdempotentAttempt('billing-payment', invoiceId);
  const record = useMutation({
    mutationFn: () => {
      const payload = { amountMinor: Math.round(Number(amount) * 100), method, reference: reference || undefined };
      return api(`/admin/billing/invoices/${invoiceId}/payments`, {
        method: 'POST',
        // The key is scoped to the invoice and fingerprinted on the payment,
        // so correcting the amount before retrying is a different payment.
        body: { ...payload, idempotencyKey: attempt.keyFor(payload) },
      });
    },
    onSuccess: () => { attempt.retire(); onDone(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'That did not work.'),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Record payment"
      width="w-[min(420px,100%)]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="cta"
            size="md"
            disabled={!amount || Number(amount) <= 0}
            pending={record.isPending}
            pendingLabel="Recording…"
            onClick={() => record.mutate()}
          >
            Record payment
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5 p-4">
        <Field label="Amount (₹)" type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} hint={`Outstanding: ${dueLabel}`} />
        <SelectField
          label="Method"
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          options={['cash', 'card', 'bank_transfer', 'upi', 'wallet', 'voucher'].map((m) => ({
            value: m,
            label: m.replace(/_/g, ' '),
          }))}
        />
        <Field label="Reference" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Optional — receipt or transaction id" />
        {error ? (
          <Panel tone="bad">
            <p className="px-3 py-2.5 text-[12px] leading-relaxed">{error}</p>
          </Panel>
        ) : null}
      </div>
    </Modal>
  );
}

function VoidSheet({ invoiceId, onClose, onDone }: { invoiceId: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: () => api(`/admin/billing/invoices/${invoiceId}/void`, { method: 'POST', body: { reason } }),
    onSuccess: onDone,
    onError: (e) => setError(e instanceof ApiError ? e.message : 'That did not work.'),
  });

  return (
    <ConfirmDialog
      open
      onClose={onClose}
      onConfirm={() => run.mutate()}
      title="Void this invoice"
      consequence="This cannot be undone. Void an invoice only when it was raised in error."
      confirmLabel="Void invoice"
      reasonLabel="Reason"
      reason={reason}
      onReasonChange={setReason}
      pending={run.isPending}
      error={error}
    />
  );
}

function RefundSheet({ paymentId, onClose, onDone }: { paymentId: string; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [entitlementReversed, setEntitlementReversed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: () => api(`/admin/billing/payments/${paymentId}/refund`, { method: 'POST', body: { amountMinor: Math.round(Number(amount) * 100), reason, entitlementReversed } }),
    onSuccess: onDone,
    onError: (e) => setError(e instanceof ApiError ? e.message : 'That did not work.'),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Refund"
      width="w-[min(420px,100%)]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="md"
            disabled={!amount || Number(amount) <= 0 || reason.trim().length < 4}
            pending={run.isPending}
            pendingLabel="Working…"
            onClick={() => run.mutate()}
          >
            Issue refund
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5 p-4">
        <Field label="Amount (₹)" type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} />
        <Field label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} hint="Required. Recorded in the audit log." />
        <Checkbox
          checked={entitlementReversed}
          onChange={(e) => setEntitlementReversed(e.target.checked)}
          label="Also reverse this member's access and credits"
          hint="Refunding money and reversing entitlements are separate decisions. Leave this off to return the money and let the member keep what they already have."
        />
        {error ? (
          <Panel tone="bad">
            <p className="px-3 py-2.5 text-[12px] leading-relaxed">{error}</p>
          </Panel>
        ) : null}
      </div>
    </Modal>
  );
}
