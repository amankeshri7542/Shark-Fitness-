import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PosOrderDetail, PosOrderSummary } from '@shark/contracts';
import { ApiError, api, idempotencyKey } from '../../lib/api';
import {
  Button,
  Chip,
  EmptyState,
  Label,
  Panel,
  Segmented,
  Skeleton,
  Stepper,
  TD,
  TH,
  THead,
  TR,
  Table,
  TableScroll,
  Toolbar,
} from '../../ui/console';
import { ConfirmDialog, Drawer } from '../../ui/overlay';
import { Money, OrderStateChip, TENDER_LABEL, dateTime, money, time } from './shared';

/* ============================================================================
   Sales history, returns and voids (PF-POS-002).

   A return and a void are different things and this screen refuses to blur
   them. A return gives back some units and some money and leaves the sale
   standing; a void cancels the whole sale. Both say which they are, in full,
   before they happen — and both wait for the server to confirm before the
   screen claims anything happened.
   ========================================================================= */

type Scope = 'all' | 'sale' | 'return' | 'voided';

export default function Orders({
  orders,
  loading,
  canManage,
  online,
  onRefetch,
}: {
  orders: PosOrderSummary[];
  loading: boolean;
  canManage: boolean;
  online: boolean;
  onRefetch: () => void;
}) {
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<Scope>('all');
  const [openId, setOpenId] = useState<string | null>(null);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return orders.filter((o) => {
      if (scope === 'sale' && (o.kind !== 'sale' || o.state === 'voided')) return false;
      if (scope === 'return' && o.kind !== 'return') return false;
      if (scope === 'voided' && o.state !== 'voided') return false;
      if (!needle) return true;
      return (
        o.reference.toLowerCase().includes(needle) ||
        o.staffName.toLowerCase().includes(needle) ||
        (o.memberName ?? '').toLowerCase().includes(needle)
      );
    });
  }, [orders, search, scope]);

  return (
    <>
      <Toolbar>
        <label className="flex min-w-0 flex-1 items-center gap-2">
          <span className="sr-only">Search sales</span>
          <input
            className="sf-field !min-h-9 !text-[13px]"
            placeholder="Receipt number, member or who sold it"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <Segmented
          label="Order type"
          value={scope}
          onChange={setScope}
          options={[
            { value: 'all', label: 'All' },
            { value: 'sale', label: 'Sales' },
            { value: 'return', label: 'Refunds' },
            { value: 'voided', label: 'Voided' },
          ]}
        />
      </Toolbar>

      <Panel>
        {loading ? (
          <Skeleton className="m-4 h-64" />
        ) : rows.length === 0 ? (
          <EmptyState
            title={orders.length === 0 ? 'No sales yet' : 'Nothing matches'}
            body={
              orders.length === 0
                ? 'Sales taken at this branch will appear here, newest first, with what was sold and how it was paid for.'
                : 'No order matches that search. Try a receipt number, or widen the filter.'
            }
          />
        ) : (
          <TableScroll className="max-h-[calc(100vh-230px)]">
            <Table>
              <THead>
                <TH>Receipt</TH>
                <TH>When</TH>
                <TH>Branch</TH>
                <TH>Member</TH>
                <TH>Sold by</TH>
                <TH align="center">State</TH>
                <TH align="right">Total</TH>
              </THead>
              <tbody>
                {rows.map((order) => (
                  <TR key={order.id} selected={openId === order.id} onClick={() => setOpenId(order.id)}>
                    <TD className="font-utility text-[11px]">
                      {order.reference}
                      {order.invoiceId ? (
                        <Chip tone="accent" className="ml-1.5">
                          Invoiced
                        </Chip>
                      ) : null}
                    </TD>
                    <TD className="whitespace-nowrap text-[12px] text-foam-65">{dateTime(order.createdAt)}</TD>
                    <TD className="text-[12px] text-foam-65">{order.branchName}</TD>
                    <TD className="text-[12px] text-foam-65">{order.memberName ?? 'Walk-in'}</TD>
                    <TD className="text-[12px] text-foam-65">{order.staffName}</TD>
                    <TD align="center">
                      <OrderStateChip state={order.state} kind={order.kind} />
                    </TD>
                    <TD numeric className={order.totalMinor < 0 ? 'text-chum' : undefined}>
                      {money(order.totalMinor)}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        )}
      </Panel>

      {openId ? (
        <OrderDrawer
          orderId={openId}
          canManage={canManage}
          online={online}
          onClose={() => setOpenId(null)}
          onChanged={onRefetch}
        />
      ) : null}
    </>
  );
}

/* — Detail, return and void ————————————————————————————————————— */

function OrderDrawer({
  orderId,
  canManage,
  online,
  onClose,
  onChanged,
}: {
  orderId: string;
  canManage: boolean;
  online: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [returning, setReturning] = useState(false);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [reason, setReason] = useState('');
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ['store', 'order', orderId],
    queryFn: () => api<PosOrderDetail>(`/admin/store/orders/${orderId}`),
  });

  const settle = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['store'] });
    onChanged();
  };

  const refund = useMutation({
    mutationFn: () =>
      api<PosOrderDetail>(`/admin/store/orders/${orderId}/refund`, {
        method: 'POST',
        idempotencyKey: idempotencyKey('pos-return', orderId, JSON.stringify(quantities)),
        body: {
          reason: reason.trim(),
          lines: Object.entries(quantities)
            .filter(([, q]) => q > 0)
            .map(([lineId, quantity]) => ({ lineId, quantity })),
        },
      }),
    onSuccess: () => {
      // Only after the server says so. Until then nothing has been refunded.
      setReturning(false);
      setQuantities({});
      setReason('');
      setError(null);
      settle();
      void detail.refetch();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'The refund did not go through.'),
  });

  const voidSale = useMutation({
    mutationFn: () =>
      api<PosOrderDetail>(`/admin/store/orders/${orderId}/void`, {
        method: 'POST',
        body: { reason: voidReason.trim() },
      }),
    onSuccess: () => {
      setVoidOpen(false);
      setVoidReason('');
      setError(null);
      settle();
      void detail.refetch();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'The void did not go through.'),
  });

  const order = detail.data?.order;
  const lines = detail.data?.lines ?? [];
  const returnable = lines.filter((l) => l.quantityReturnable > 0);
  const picked = Object.values(quantities).reduce((sum, q) => sum + q, 0);

  // What the refund is worth, priced the way the server prices it: the same
  // proportion of what was actually charged, discount and tax included.
  const refundMinor = lines.reduce((sum, line) => {
    const qty = quantities[line.id] ?? 0;
    if (qty === 0 || line.quantity === 0) return sum;
    const share = qty / line.quantity;
    const gross = line.unitMinor * qty;
    return sum + gross - Math.round(line.discountMinor * share) + Math.round(line.taxMinor * share);
  }, 0);

  const canAct = canManage && online && order?.kind === 'sale' && order.state !== 'voided';

  return (
    <>
      <Drawer
        open
        onClose={onClose}
        kicker={order ? dateTime(order.createdAt) : 'Loading'}
        title={order?.reference ?? 'Receipt'}
        footer={
          canAct ? (
            <div className="flex items-center gap-2">
              {returning ? (
                <>
                  <Button variant="outline" onClick={() => setReturning(false)} disabled={refund.isPending}>
                    Cancel
                  </Button>
                  <Button
                    variant="cta"
                    className="flex-1"
                    disabled={picked === 0 || reason.trim().length < 4 || refund.isPending}
                    onClick={() => refund.mutate()}
                  >
                    {refund.isPending ? 'Refunding…' : `Refund ${money(refundMinor)}`}
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="danger" onClick={() => setVoidOpen(true)}>
                    Void sale
                  </Button>
                  <Button
                    variant="cta"
                    className="flex-1"
                    disabled={returnable.length === 0}
                    onClick={() => setReturning(true)}
                  >
                    {returnable.length === 0 ? 'Fully returned' : 'Return items'}
                  </Button>
                </>
              )}
            </div>
          ) : null
        }
      >
        {detail.isLoading || !order ? (
          <Skeleton className="m-3 h-48" />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
              <OrderStateChip state={order.state} kind={order.kind} />
              <span className="text-[12px] text-foam-65">
                {order.branchName} · {order.staffName} · {time(order.createdAt)}
              </span>
              <span className="flex-1" />
              <span className="text-[15px] tabular-nums">{money(order.totalMinor)}</span>
            </div>

            {order.memberName ? (
              <div className="border-b border-line-10 px-3 py-2 text-[12px] text-foam-65">
                Sold to {order.memberName}
                {order.invoiceId ? ' · charged to their account' : ''}
              </div>
            ) : null}

            {order.state === 'voided' ? (
              <p className="border-b border-line bg-wash-chum px-3 py-2 text-[12px] text-foam-80">
                Voided{order.voidedAt ? ` on ${dateTime(order.voidedAt)}` : ''}. Reason: {order.voidReason}
              </p>
            ) : null}

            {detail.data?.returnedFrom ? (
              <p className="border-b border-line bg-wash-flare px-3 py-2 text-[12px] text-foam-80">
                This is a refund against {detail.data.returnedFrom.reference}.
              </p>
            ) : null}

            <TableScroll>
              <Table>
                <THead>
                  <TH>Item</TH>
                  <TH align="right">Qty</TH>
                  <TH align="right">Unit</TH>
                  <TH align="right">Tax</TH>
                  <TH align="right">Total</TH>
                  {returning ? <TH align="right">Return</TH> : null}
                </THead>
                <tbody>
                  {lines.map((line) => (
                    <TR key={line.id}>
                      <TD>
                        <div className="max-w-[24ch] truncate">{line.name}</div>
                        {line.quantityReturned > 0 ? (
                          <div className="text-[10px] uppercase tracking-[0.1em] text-flare">
                            {line.quantityReturned} returned
                          </div>
                        ) : null}
                      </TD>
                      <TD numeric>{line.quantity}</TD>
                      <TD numeric className="text-foam-65">
                        {money(line.unitMinor)}
                      </TD>
                      <TD numeric className="text-foam-65">
                        {money(line.taxMinor)}
                      </TD>
                      <TD numeric>{money(line.totalMinor)}</TD>
                      {returning ? (
                        <TD align="right">
                          {line.quantityReturnable > 0 ? (
                            <div className="flex justify-end">
                              <Stepper
                                value={quantities[line.id] ?? 0}
                                min={0}
                                max={line.quantityReturnable}
                                label={line.name}
                                onChange={(q) => setQuantities({ ...quantities, [line.id]: q })}
                              />
                            </div>
                          ) : (
                            <span className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
                              None left
                            </span>
                          )}
                        </TD>
                      ) : null}
                    </TR>
                  ))}
                </tbody>
              </Table>
            </TableScroll>

            <dl className="border-t border-line px-3 py-2 text-[13px]">
              <Line label="Subtotal" value={money(order.subtotalMinor)} />
              {order.discountMinor !== 0 ? <Line label="Discount" value={money(-order.discountMinor)} /> : null}
              <Line label="Tax" value={money(order.taxMinor)} />
              <Line label="Total" value={money(order.totalMinor)} strong />
            </dl>

            <section className="border-t border-line">
              <div className="px-3 py-2">
                <Label>Paid with</Label>
              </div>
              <ul>
                {(detail.data?.tenders ?? []).map((tender) => (
                  <li
                    key={tender.id}
                    className="flex items-center gap-2 border-t border-line-10 px-3 py-2 text-[12px]"
                  >
                    <Chip tone="neutral" glyph={false}>
                      {TENDER_LABEL[tender.method] ?? tender.method}
                    </Chip>
                    <span className="flex-1 truncate text-foam-45">{tender.reference || '—'}</span>
                    <span className="tabular-nums">{money(tender.amountMinor)}</span>
                  </li>
                ))}
              </ul>
            </section>

            {detail.data?.financial.canSeeMargin ? (
              <section className="border-t border-line px-3 py-2">
                <Label>Cost at sale</Label>
                <ul className="mt-1.5">
                  {lines.map((line) => (
                    <li key={line.id} className="flex justify-between text-[12px] text-foam-65">
                      <span className="truncate">{line.name}</span>
                      <span className="tabular-nums">
                        <Money minor={line.unitCostMinor} />
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {returning ? (
              <section className="border-t border-line bg-wash-flare p-3">
                <Label>Why is this coming back?</Label>
                <textarea
                  className="sf-field mt-1.5 !min-h-[64px] !text-[13px]"
                  value={reason}
                  aria-label="Reason for the refund"
                  placeholder="Wrong size, faulty, changed their mind…"
                  onChange={(e) => setReason(e.target.value)}
                />
                <p className="mt-1.5 text-[12px] text-foam-80">
                  {picked === 0
                    ? 'Pick how many of each item are coming back.'
                    : `${picked} item${picked === 1 ? '' : 's'} back on the shelf, ${money(refundMinor)} refunded. The original sale is not edited — this writes a separate refund against it.`}
                </p>
              </section>
            ) : null}

            {error ? (
              <p role="alert" className="border-t border-line bg-wash-chum px-3 py-2 text-[12px] text-foam-80">
                {error}
              </p>
            ) : null}

            {!online ? (
              <p className="border-t border-line bg-wash-flare px-3 py-2 text-[12px] text-foam-80">
                Offline. Refunds and voids need a connection.
              </p>
            ) : null}
          </>
        )}
      </Drawer>

      <ConfirmDialog
        open={voidOpen}
        onClose={() => setVoidOpen(false)}
        onConfirm={() => voidSale.mutate()}
        title={`Void ${order?.reference ?? 'this sale'}?`}
        consequence={`The whole sale is cancelled and ${money(Math.abs(order?.totalMinor ?? 0))} comes out of today's takings. Every unsold unit goes back on the shelf. The sale stays in the history marked voided, with your reason against it — it is not deleted, and it cannot be undone.`}
        confirmLabel="Void the sale"
        reasonLabel="Reason"
        reason={voidReason}
        onReasonChange={setVoidReason}
        pending={voidSale.isPending}
        error={voidSale.isError ? error : null}
      />
    </>
  );
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={strong ? 'mt-1 flex justify-between border-t border-line-10 pt-1 font-semibold' : 'flex justify-between text-foam-65'}>
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
