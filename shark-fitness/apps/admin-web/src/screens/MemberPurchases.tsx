import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccessRules, CancellationPolicy, CreditAccount, FreezeRules } from '@shark/contracts';
import { api } from '../lib/api';
import { usePermission } from '../lib/store';
import { useIdempotentAttempt } from '../lib/idempotent-attempt';
import { Button, Checkbox, ErrorState, Panel, SelectField } from '../ui/console';
import { Modal } from '../ui/overlay';

interface Quote {
  quoteToken: string; productId: string; productName: string; startedOn: string; endsOn: string | null;
  totalLabel: string; priceLabel: string; taxLabel: string; requiresApproval: boolean; consequence: string;
  freezeFeeLabel: string; cancellationFeeLabel: string; branchNames: string[];
  freeze: FreezeRules; cancellation: CancellationPolicy; access: AccessRules;
  debts: Array<{ invoiceId: string; number: string; dueLabel: string }>;
}

export function MemberPurchases({ memberId }: { memberId: string }) {
  const canManage = usePermission('membership.manage');
  const [renew, setRenew] = useState(false);
  const [history, setHistory] = useState(false);
  const credits = useQuery({ queryKey: ['member-credits', memberId], queryFn: () => api<CreditAccount>(`/admin/billing/members/${memberId}/credits`) });
  return <Panel title="Purchases and renewals"><div className="space-y-3 p-3.5 text-[13px]">
    <p>Manual renewal is available after a term expires or is cancelled. Pending, active, frozen, grace and suspended terms must be resolved first.</p>
    {canManage ? <Button onClick={() => setRenew(true)}>Review renewal</Button> : null}
    {credits.isLoading ? <p>Loading credit ledger…</p> : null}
    {credits.error ? <ErrorState title="Could not load credits" body={credits.error.message} onRetry={() => void credits.refetch()} /> : null}
    {credits.data ? <>
      <div className="border-t border-line pt-3"><strong>Credit balances</strong>{credits.data.balances.map((balance) => <div key={balance.kind} className="mt-2">
        <p>{balance.kind === 'class' ? 'Class' : 'PT'}: {balance.signedBalance} units after expiry. {balance.consumptionAvailable ? `${balance.usableUnits} usable units; booking eligibility also applies.` : 'Consumption unavailable.'}</p>
        {balance.warning ? <p role="alert" className="text-chum">{balance.warning}</p> : null}
      </div>)}</div>
      <p>{credits.data.saleUnavailableReason}</p>
      <Button onClick={() => setHistory(!history)}>{history ? 'Hide credit history' : 'View credit history'}</Button>
      {history ? <><p>{credits.data.historyNotice}</p>{credits.data.entries.length ? <ul className="divide-y divide-line">{credits.data.entries.map((entry) => <li key={entry.id} className="py-2">
        <p>{entry.kind}: {entry.delta > 0 ? '+' : ''}{entry.delta} units · {entry.reason}</p>
        <p>{entry.createdAt.slice(0, 10)} · {entry.expiresOn ? `${entry.expired ? 'Expired' : 'Expires'} ${entry.expiresOn}` : 'No recorded expiry'}</p>
        <p className="break-all text-[11px] text-foam-45">{entry.id}{entry.refId ? ` · ${entry.refType}: ${entry.refId}` : ''}</p>
      </li>)}</ul> : <p>No credit ledger entries.</p>}</> : null}
    </> : null}
    {renew ? <RenewalDialog memberId={memberId} onClose={() => setRenew(false)} /> : null}
  </div></Panel>;
}

function RenewalDialog({ memberId, onClose }: { memberId: string; onClose: () => void }) {
  const client = useQueryClient();
  const attempt = useIdempotentAttempt('membership-renew', memberId);
  const [productId, setProductId] = useState('');
  const [approved, setApproved] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const products = useQuery({ queryKey: ['products'], queryFn: () => api<{ items: Array<{ id: string; name: string; kind: string; status: string }> }>('/admin/billing/products') });
  const quote = useQuery({ queryKey: ['renewal-quote', memberId, productId], queryFn: () => api<Quote>(`/admin/billing/members/${memberId}/renewal-quote${productId ? `?productId=${encodeURIComponent(productId)}` : ''}`), retry: false });
  const submit = useMutation({ mutationFn: async () => {
    if (!quote.data) return;
    const body = { productId: quote.data.productId, quoteToken: quote.data.quoteToken, eligibilityApproved: approved };
    return api(`/admin/billing/members/${memberId}/renew`, { method: 'POST', body, idempotencyKey: attempt.keyFor(body) });
  }, onSuccess: () => {
    attempt.retire();
    for (const key of [['member', memberId], ['members'], ['invoices'], ['billing-summary']]) void client.invalidateQueries({ queryKey: key });
    onClose();
  } });
  const refresh = () => { setConfirmed(false); submit.reset(); void quote.refetch(); };
  return <Modal open onClose={() => { if (!submit.isPending) onClose(); }} title="Review manual renewal" footer={<>
    <Button onClick={onClose} disabled={submit.isPending}>Cancel</Button>
    <Button variant="cta" onClick={() => submit.mutate()} disabled={!quote.data || !confirmed || (quote.data.requiresApproval && !approved) || submit.isPending || quote.isFetching}>Confirm renewal</Button>
  </>}><div className="space-y-4 p-4 text-[13px]">
    <SelectField label="Renewal plan" value={productId} onChange={(event) => { setProductId(event.target.value); setConfirmed(false); setApproved(false); submit.reset(); }} options={[
      { value: '', label: 'Previous plan at current published terms' },
      ...(products.data?.items.filter((item) => item.status === 'active' && ['membership', 'trial', 'day_pass', 'corporate', 'digital'].includes(item.kind)).map((item) => ({ value: item.id, label: item.name })) ?? []),
    ]} />
    {products.error ? <p role="alert">Could not load alternative plans. <button className="underline" onClick={() => void products.refetch()}>Retry plans</button></p> : null}
    {quote.isFetching ? <p>Loading current terms…</p> : null}
    {quote.error ? <ErrorState title="Renewal unavailable" body={quote.error.message} onRetry={refresh} /> : null}
    {quote.data && !quote.error ? <>
      <p><strong>{quote.data.productName}</strong><br />{quote.data.startedOn} through {quote.data.endsOn ?? 'no fixed end date'}</p>
      <p>Price {quote.data.priceLabel} + recorded tax {quote.data.taxLabel} = <strong>{quote.data.totalLabel}</strong></p>
      <p>Access: {quote.data.access.allBranches ? 'all branches' : quote.data.branchNames.join(', ')}. {quote.data.access.windowStartMin === null ? 'No time window.' : `Access ${clockTime(quote.data.access.windowStartMin)}–${clockTime(quote.data.access.windowEndMin)}.`} {quote.data.access.visitsPerWeek === null ? 'No weekly visit limit.' : `${quote.data.access.visitsPerWeek} visits per week.`} Guest passes: {quote.data.access.guestPassesPerMonth} per month. Booking window: {quote.data.access.bookingWindowHours} hours.</p>
      <p>Freeze: {quote.data.freeze.allowed ? `Minimum ${quote.data.freeze.minDaysPerFreeze} days per request, maximum ${quote.data.freeze.maxDaysPerTerm} days per term; ${quote.data.freeze.extendsExpiry ? 'extends expiry' : 'does not extend expiry'}; fee ${quote.data.freezeFeeLabel}.` : 'Unavailable.'}</p>
      <p>Cancellation: {quote.data.cancellation.description} Notice {quote.data.cancellation.noticeDays} days; commitment {quote.data.cancellation.commitmentMonths} months; early exit fee {quote.data.cancellationFeeLabel}. {quote.data.cancellation.refundable ? 'Refund eligibility follows these terms.' : 'Non-refundable.'}</p>
      <p>{quote.data.consequence}</p>
      <div><strong>Existing unpaid principal</strong>{quote.data.debts.length ? <ul>{quote.data.debts.map((debt) => <li key={debt.invoiceId}>{debt.number}: {debt.dueLabel}</li>)}</ul> : <p>None.</p>}</div>
      {quote.data.requiresApproval ? <Checkbox label="I verified eligibility approval for this plan" checked={approved} onChange={(event) => setApproved(event.target.checked)} /> : null}
      <Checkbox label="I reviewed the dates, terms, new price and existing debt with the member" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
    </> : null}
    {submit.error ? <ErrorState title="Renewal was not confirmed" body={submit.error.message} onRetry={refresh} /> : null}
  </div></Modal>;
}

function clockTime(minutes: number | null) {
  return minutes === null ? 'unspecified' : `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
