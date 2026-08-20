import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PosOrderDetail, PosTenderMethod, StoreProduct } from '@shark/contracts';
import { ApiError, OfflineError, api } from '../../lib/api';
import { useIdempotentAttempt } from '../../lib/idempotent-attempt';
import {
  Button,
  Chip,
  Display,
  EmptyState,
  Label,
  Metric,
  Panel,
  Skeleton,
  Stepper,
  cx,
} from '../../ui/console';
import { TENDER_LABEL, TENDER_NEEDS_REFERENCE, money, StockChip } from './shared';

/* ============================================================================
   The till (PF-POS-002).

   The signature of this screen is the **remaining balance**. Mixed tender has
   to settle to the penny — the server refuses anything else, because letting a
   basket round would quietly create or destroy money in the day's takings — so
   rather than hide that behind a validation message after the fact, the amount
   still to collect is the largest number on the panel and counts down to zero
   as tenders are added. When it reaches zero it turns from cyan to green and
   the payment button enables. Nothing else on this screen is loud.
   ========================================================================= */

interface BasketLine {
  product: StoreProduct;
  quantity: number;
  discountMinor: number;
}

interface Tender {
  method: PosTenderMethod;
  amountMinor: number;
  reference: string;
}

/**
 * A row from `/admin/members`, in the shape that route actually serves.
 *
 * It sends one `name`. This asked for `firstName` and `lastName`, which it has
 * never sent, so every result rendered as a blank line above its member number
 * and the attached-member banner named nobody — a client-side fork of a server
 * shape that typechecks while it disagrees, which is the exact failure
 * `schemas/pos.ts` exists to prevent. The test fixture invented the missing
 * fields, so the suite could not see it; a browser could, immediately.
 */
interface MemberHit {
  id: string;
  memberNo: string;
  name: string;
  lifecycle: string;
}

export default function Register({
  products,
  loading,
  branchId,
  branchName,
  canManage,
  online,
}: {
  products: StoreProduct[];
  loading: boolean;
  branchId: string | null;
  branchName: string;
  canManage: boolean;
  online: boolean;
}) {
  const queryClient = useQueryClient();
  const [basket, setBasket] = useState<BasketLine[]>([]);
  const [tenders, setTenders] = useState<Tender[]>([]);
  const [member, setMember] = useState<MemberHit | null>(null);
  const [search, setSearch] = useState('');
  const [memberQuery, setMemberQuery] = useState('');
  const [receipt, setReceipt] = useState<PosOrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  /* — The checkout attempt.

     One logical attempt owns one key for as long as it is the same attempt.
     The key used to be minted inside `mutationFn`, and `idempotencyKey()`
     ends every key with a random suffix, so pressing the button a second time
     after a lost response asked the server a brand-new question and got a
     second sale for the same goods and the same money. That is the exact
     failure the header exists to prevent, and a till is where it costs most.

     Retrying an unchanged basket reuses the key; changing the basket, the
     tender or the member changes the body and mints a new one, because that is
     a different sale and must not replay the last one's receipt. — */
  const attempt = useIdempotentAttempt('pos', branchId ?? 'none');

  /* — Money. Mirrors the server's rule exactly: tax per line, then summed.
       Summing first and taxing the total drifts by a rupee or two on a
       mixed-rate basket, which is the kind of error a shop notices at close of
       day and cannot explain. — */
  const totals = useMemo(() => {
    let subtotal = 0;
    let discount = 0;
    let tax = 0;
    for (const line of basket) {
      const gross = line.product.priceMinor * line.quantity;
      const taxable = gross - line.discountMinor;
      subtotal += gross;
      discount += line.discountMinor;
      tax += Math.round((taxable * line.product.taxRateBp) / 10_000);
    }
    return { subtotal, discount, tax, total: subtotal - discount + tax };
  }, [basket]);

  const tendered = tenders.reduce((sum, t) => sum + t.amountMinor, 0);
  const remaining = totals.total - tendered;
  const settled = basket.length > 0 && remaining === 0;

  /* — An account charge with no member is knowably invalid before it is sent.
       `invoices.member_id` is NOT NULL, so the server refuses it — the server
       stays the authority and that refusal is tested. But the till already
       knows, and letting the button be pressed spends a round trip to be told
       something the screen could see, at the one moment an operator is
       standing in front of a customer. So the warning that was already here
       now also holds the action. — */
  const accountNeedsMember = tenders.some((t) => t.method === 'account') && member === null;
  const sellable = settled && !accountNeedsMember;

  /* — Catalogue search. A scanner types fast and ends with Enter, so an exact
       barcode match adds straight to the basket and clears the box. — */
  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return products.filter((p) => p.active).slice(0, 40);
    return products
      .filter(
        (p) =>
          p.active &&
          (p.displayName.toLowerCase().includes(needle) ||
            p.sku.toLowerCase().includes(needle) ||
            (p.barcode ?? '').toLowerCase().includes(needle)),
      )
      .slice(0, 40);
  }, [products, search]);

  /* — Member lookup.

     Debounced, because the box is typed into at counter speed and every
     keystroke was a request: "Priyanka" fired eight searches to answer one
     question, and the answers could land out of order. 250 ms is short enough
     that the list still appears while the operator is looking at it. The
     query key holds the *settled* term, so React Query caches by what was
     actually asked rather than by every prefix on the way there. — */
  const settledQuery = useDebounced(memberQuery.trim(), 250);
  const memberHits = useQuery({
    queryKey: ['store', 'member-lookup', settledQuery],
    queryFn: () => api<{ items: MemberHit[] }>(`/admin/members?q=${encodeURIComponent(settledQuery)}&limit=6`),
    enabled: settledQuery.length >= 2,
    // A member's name does not change while a queue is being served.
    staleTime: 30_000,
  });

  /** Exactly what goes on the wire, and exactly what the fingerprint covers. */
  const checkoutBody = useMemo(
    () => ({
      branchId,
      memberId: member?.id ?? null,
      lines: basket.map((l) => ({
        productId: l.product.id,
        quantity: l.quantity,
        discountMinor: l.discountMinor,
      })),
      payments: tenders.map((t) => ({
        method: t.method,
        amountMinor: t.amountMinor,
        reference: t.reference,
      })),
    }),
    [branchId, member, basket, tenders],
  );

  const sell = useMutation({
    mutationFn: () =>
      api<PosOrderDetail>('/admin/store/orders', {
        method: 'POST',
        idempotencyKey: attempt.keyFor(checkoutBody),
        body: checkoutBody,
      }),
    onSuccess: (order) => {
      // The receipt is the server's answer, not a local echo of the basket.
      // Nothing is cleared until the sale is known to have happened.
      setReceipt(order);
      setBasket([]);
      setTenders([]);
      setMember(null);
      setError(null);
      // This attempt is spent. Retiring it matters because the next customer
      // can buy exactly the same thing: an identical basket would otherwise
      // fingerprint the same, reuse this key, and be answered with *this*
      // receipt — a real second sale silently swallowed as a duplicate.
      attempt.retire();
      void queryClient.invalidateQueries({ queryKey: ['store'] });
    },
    onError: (e) => {
      // Not "nothing was charged" — from here that is unknowable, and the
      // till is the worst place to state it wrongly.
      if (e instanceof OfflineError)
        setError('No connection. If the sale went through, taking it again will not charge twice.');
      else setError(e instanceof ApiError ? e.message : 'The sale did not go through. Nothing was charged.');
    },
  });

  const addLine = (product: StoreProduct): void => {
    setReceipt(null);
    setError(null);
    setBasket((current) => {
      const existing = current.find((l) => l.product.id === product.id);
      if (!existing) return [...current, { product, quantity: 1, discountMinor: 0 }];
      if (existing.quantity >= product.onHand) return current;
      return current.map((l) => (l.product.id === product.id ? { ...l, quantity: l.quantity + 1 } : l));
    });
  };

  const setQuantity = (productId: string, quantity: number): void => {
    setBasket((current) =>
      quantity <= 0
        ? current.filter((l) => l.product.id !== productId)
        : current.map((l) => (l.product.id === productId ? { ...l, quantity } : l)),
    );
  };

  const setDiscount = (productId: string, discountMinor: number): void => {
    setBasket((current) =>
      current.map((l) => {
        if (l.product.id !== productId) return l;
        const gross = l.product.priceMinor * l.quantity;
        // Clamped to the line so the basket can never total less than nothing.
        return { ...l, discountMinor: Math.max(0, Math.min(gross, discountMinor)) };
      }),
    );
  };

  /* — Tender — */
  const addTender = (method: PosTenderMethod): void => {
    if (remaining <= 0) return;
    setTenders((current) => [...current, { method, amountMinor: remaining, reference: '' }]);
  };

  const patchTender = (index: number, patch: Partial<Tender>): void => {
    setTenders((current) => current.map((t, i) => (i === index ? { ...t, ...patch } : t)));
  };

  const startNewSale = (): void => {
    setReceipt(null);
    setError(null);
    searchRef.current?.focus();
  };

  useEffect(() => {
    if (!receipt) searchRef.current?.focus();
  }, [receipt]);

  /* — Blocked states, most specific first — */

  if (!canManage) {
    return (
      <Panel>
        <div className="flex flex-col items-start gap-2 p-6">
          <Label>Not available to your role</Label>
          <p className="max-w-[46ch] text-[13px] leading-relaxed text-foam-65">
            Your role can read the shop but not take a sale. Inventory, orders and transfers are
            still yours to see.
          </p>
        </div>
      </Panel>
    );
  }

  if (!branchId) {
    return (
      <Panel>
        <EmptyState
          title="Pick a branch to open the till"
          body={`A till belongs to one shop floor — its stock, its takings and its staff. You are looking at ${branchName}; choose a single branch in the bar above to start selling.`}
        />
      </Panel>
    );
  }

  return (
    <div className="grid min-h-0 gap-px bg-line lg:grid-cols-[1.5fr_minmax(360px,1fr)]">
      {/* — Catalogue — */}
      <Panel
        title={`Catalogue · ${matches.length}`}
        action={
          <span className="font-utility text-[9px] uppercase tracking-[0.12em] text-foam-35">
            Scan or type
          </span>
        }
      >
        <div className="border-b border-line p-3">
          <label className="sr-only" htmlFor="register-search">
            Search the catalogue by name, SKU or barcode
          </label>
          <input
            id="register-search"
            ref={searchRef}
            className="sf-field !min-h-10 !text-[14px]"
            placeholder="Scan a barcode, or type a name or SKU"
            value={search}
            autoComplete="off"
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              const needle = search.trim().toLowerCase();
              // A scanner ends with Enter. An exact barcode is unambiguous, so
              // it rings straight through; anything else needs a human to pick.
              const exact = products.find((p) => (p.barcode ?? '').toLowerCase() === needle);
              const target = exact ?? (matches.length === 1 ? matches[0] : undefined);
              if (target && target.onHand > 0) {
                addLine(target);
                setSearch('');
              }
            }}
          />
        </div>

        {loading ? (
          <Skeleton className="m-3 h-48" />
        ) : matches.length === 0 ? (
          <EmptyState
            title="Nothing matches"
            body="No product at this branch matches that name, SKU or barcode. Check Inventory to add it."
          />
        ) : (
          <ul className="max-h-[calc(100vh-320px)] overflow-y-auto">
            {matches.map((product) => {
              const soldOut = product.onHand <= 0;
              return (
                <li key={product.id}>
                  <button
                    type="button"
                    disabled={soldOut}
                    onClick={() => addLine(product)}
                    aria-label={`Add ${product.displayName}, ${money(product.priceMinor)}`}
                    className={cx(
                      'flex w-full items-center gap-3 border-b border-line-10 px-3 py-2.5 text-left transition-colors',
                      soldOut
                        ? 'cursor-not-allowed opacity-45'
                        : 'cursor-pointer hover:bg-wash-sonar-soft focus-visible:bg-wash-sonar-soft',
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px]">{product.displayName}</div>
                      <div className="truncate font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
                        {product.sku}
                        {product.category ? ` · ${product.category}` : ''}
                      </div>
                    </div>
                    <StockChip onHand={product.onHand} lowStock={product.lowStock} />
                    <span className="w-20 text-right text-[13px] tabular-nums">{money(product.priceMinor)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      {/* — The sale — */}
      <div className="flex min-h-0 flex-col bg-hull">
        {receipt ? (
          <Receipt detail={receipt} onNewSale={startNewSale} />
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <MemberPicker
                member={member}
                query={memberQuery}
                results={memberHits.data?.items ?? []}
                searching={memberHits.isFetching}
                settling={memberQuery.trim() !== settledQuery}
                onQuery={setMemberQuery}
                onPick={(hit) => {
                  setMember(hit);
                  setMemberQuery('');
                }}
                onClear={() => setMember(null)}
              />

              {basket.length === 0 ? (
                <EmptyState
                  title="No sale in progress"
                  body="Scan an item or pick one from the catalogue to start. Nothing is charged until you take payment."
                />
              ) : (
                <ul>
                  {basket.map((line) => {
                    const gross = line.product.priceMinor * line.quantity;
                    const lineTax = Math.round(
                      ((gross - line.discountMinor) * line.product.taxRateBp) / 10_000,
                    );
                    return (
                      <li key={line.product.id} className="border-b border-line-10 px-3 py-2.5">
                        <div className="flex items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[13px]">{line.product.displayName}</div>
                            <div className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
                              {money(line.product.priceMinor)} each ·{' '}
                              {(line.product.taxRateBp / 100).toFixed(0)}% tax
                            </div>
                          </div>
                          <Stepper
                            value={line.quantity}
                            min={0}
                            max={line.product.onHand}
                            label={line.product.displayName}
                            onChange={(q) => setQuantity(line.product.id, q)}
                          />
                        </div>

                        <div className="mt-1.5 flex items-center gap-2">
                          <label className="flex items-center gap-1.5">
                            <span className="font-utility text-[9px] uppercase tracking-[0.12em] text-foam-45">
                              Discount ₹
                            </span>
                            <input
                              type="number"
                              min={0}
                              max={gross / 100}
                              step="1"
                              aria-label={`Discount on ${line.product.displayName} in rupees`}
                              value={line.discountMinor === 0 ? '' : line.discountMinor / 100}
                              placeholder="0"
                              onChange={(e) => {
                                const rupees = Number.parseFloat(e.target.value);
                                setDiscount(
                                  line.product.id,
                                  Number.isNaN(rupees) ? 0 : Math.round(rupees * 100),
                                );
                              }}
                              className="sf-field !min-h-8 !w-20 !px-1.5 !py-1 !text-right !text-[12px] tabular-nums"
                            />
                          </label>
                          <span className="flex-1" />
                          <span className="text-[13px] tabular-nums">
                            {money(gross - line.discountMinor + lineTax)}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}

              {basket.length > 0 ? (
                <TenderList
                  tenders={tenders}
                  remaining={remaining}
                  onAdd={addTender}
                  onPatch={patchTender}
                  onRemove={(index) => setTenders((c) => c.filter((_, i) => i !== index))}
                  memberPicked={member !== null}
                />
              ) : null}
            </div>

            {/* — The sticky foot. Totals and the one action that takes money. — */}
            {basket.length > 0 ? (
              <div className="flex-none border-t border-line bg-panel">
                <section aria-label="Sale totals">
                <dl className="px-3 py-2.5 text-[13px]">
                  <Row label="Subtotal" value={money(totals.subtotal)} />
                  {totals.discount > 0 ? (
                    <Row label="Discount" value={`−${money(totals.discount)}`} tone="warn" />
                  ) : null}
                  <Row label="Tax" value={money(totals.tax)} />
                  <div className="mt-1.5 flex items-baseline justify-between border-t border-line-10 pt-1.5">
                    <span className="font-utility text-[10px] font-semibold uppercase tracking-[0.14em] text-foam-45">
                      Total
                    </span>
                    <Metric value={money(totals.total)} size="sm" />
                  </div>
                </dl>
                </section>

                <div
                  className={cx(
                    'flex items-baseline justify-between border-t px-3 py-2.5',
                    settled ? 'border-line-10 bg-wash-kelp' : 'border-line-accent bg-wash-sonar',
                  )}
                >
                  <span className="font-utility text-[10px] font-semibold uppercase tracking-[0.14em] text-foam-45">
                    {settled ? 'Settled' : remaining < 0 ? 'Over-tendered' : 'Remaining'}
                  </span>
                  <Metric
                    value={money(Math.abs(remaining))}
                    tone={settled ? 'good' : remaining < 0 ? 'bad' : 'accent'}
                  />
                </div>

                {error ? (
                  <p role="alert" className="border-t border-line-10 bg-wash-chum px-3 py-2 text-[12px] text-foam-80">
                    {error}
                  </p>
                ) : null}

                <div className="p-3">
                  <Button
                    variant="cta"
                    full
                    size="md"
                    disabled={!online || sell.isPending || !sellable}
                    onClick={() => sell.mutate()}
                  >
                    {sell.isPending
                      ? 'Taking payment…'
                      : !online
                        ? 'Offline — cannot take payment'
                        : accountNeedsMember
                          ? 'Attach a member to charge an account'
                          : settled
                            ? `Take ${money(totals.total)}`
                            : `${money(Math.abs(remaining))} still to ${remaining < 0 ? 'return' : 'collect'}`}
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return (
    <div className="flex justify-between text-foam-65">
      <dt>{label}</dt>
      <dd className={cx('tabular-nums', tone === 'warn' && 'text-flare')}>{value}</dd>
    </div>
  );
}

/* — Member — */

/** Holds a value still until typing stops, so a fast field is not a fast API. */
function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

function MemberPicker({
  member,
  query,
  results,
  searching,
  settling,
  onQuery,
  onPick,
  onClear,
}: {
  member: MemberHit | null;
  query: string;
  results: MemberHit[];
  searching: boolean;
  /** The term has changed but the debounce has not released it yet. */
  settling: boolean;
  onQuery: (value: string) => void;
  onPick: (hit: MemberHit) => void;
  onClear: () => void;
}) {
  if (member) {
    return (
      <div className="flex items-center gap-2 border-b border-line bg-wash-sonar-soft px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px]">{member.name}</div>
          <div className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
            {member.memberNo} · {member.lifecycle}
          </div>
        </div>
        <Button variant="ghost" onClick={onClear}>
          Remove
        </Button>
      </div>
    );
  }

  return (
    <div className="border-b border-line px-3 py-2">
      <label className="sr-only" htmlFor="register-member">
        Attach a member to this sale
      </label>
      <input
        id="register-member"
        className="sf-field !min-h-9 !text-[13px]"
        placeholder="Attach a member (optional) — name, number or phone"
        value={query}
        autoComplete="off"
        onChange={(e) => onQuery(e.target.value)}
      />
      {query.trim().length >= 2 ? (
        <ul className="mt-1.5 border border-line">
          {settling || (searching && results.length === 0) ? (
            <li className="px-2.5 py-2 text-[12px] text-foam-45">Looking…</li>
          ) : results.length === 0 ? (
            <li className="px-2.5 py-2 text-[12px] text-foam-45">
              No member matches “{query}”. A sale without one is a walk-in.
            </li>
          ) : (
            results.map((hit) => (
              <li key={hit.id}>
                <button
                  type="button"
                  onClick={() => onPick(hit)}
                  className="flex w-full cursor-pointer items-center justify-between gap-2 border-b border-line-10 px-2.5 py-1.5 text-left text-[12px] last:border-b-0 hover:bg-wash-sonar"
                >
                  <span className="truncate">{hit.name}</span>
                  <span className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
                    {hit.memberNo}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}

/* — Tender — */

function TenderList({
  tenders,
  remaining,
  onAdd,
  onPatch,
  onRemove,
  memberPicked,
}: {
  tenders: Tender[];
  remaining: number;
  onAdd: (method: PosTenderMethod) => void;
  onPatch: (index: number, patch: Partial<Tender>) => void;
  onRemove: (index: number) => void;
  memberPicked: boolean;
}) {
  const methods: PosTenderMethod[] = ['cash', 'card', 'upi', 'account'];

  return (
    <div className="border-t border-line">
      <div className="flex items-center gap-2 px-3 py-2">
        <Label>Payment</Label>
        <span className="flex-1" />
        {tenders.length > 0 ? (
          <span className="font-utility text-[9px] uppercase tracking-[0.12em] text-foam-35">
            {tenders.length} tender{tenders.length === 1 ? '' : 's'}
          </span>
        ) : null}
      </div>

      <ul>
        {tenders.map((tender, index) => (
          <li key={index} className="flex flex-wrap items-center gap-2 border-t border-line-10 px-3 py-2">
            <Chip tone="neutral" glyph={false}>
              {TENDER_LABEL[tender.method]}
            </Chip>
            <label className="flex items-center gap-1.5">
              <span className="sr-only">{TENDER_LABEL[tender.method]} amount in rupees</span>
              <span aria-hidden="true" className="text-[12px] text-foam-45">
                ₹
              </span>
              <input
                type="number"
                min={0}
                step="1"
                value={tender.amountMinor / 100}
                onChange={(e) => {
                  const rupees = Number.parseFloat(e.target.value);
                  onPatch(index, { amountMinor: Number.isNaN(rupees) ? 0 : Math.round(rupees * 100) });
                }}
                className="sf-field !min-h-8 !w-24 !px-1.5 !py-1 !text-right !text-[12px] tabular-nums"
              />
            </label>
            {TENDER_NEEDS_REFERENCE[tender.method] ? (
              <input
                aria-label={`${TENDER_LABEL[tender.method]} reference`}
                placeholder={tender.method === 'card' ? 'Auth code' : 'UPI reference'}
                value={tender.reference}
                onChange={(e) => onPatch(index, { reference: e.target.value })}
                className="sf-field !min-h-8 !w-28 !flex-1 !px-1.5 !py-1 !text-[12px]"
              />
            ) : (
              <span className="flex-1" />
            )}
            <Button
              variant="ghost"
              aria-label={`Remove the ${TENDER_LABEL[tender.method]} tender`}
              onClick={() => onRemove(index)}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>

      {remaining > 0 ? (
        <div className="flex flex-wrap gap-1.5 border-t border-line-10 px-3 py-2">
          {methods.map((method) => (
            <Button key={method} onClick={() => onAdd(method)}>
              {TENDER_LABEL[method]}
            </Button>
          ))}
        </div>
      ) : null}

      {/* Stated before the sale is attempted rather than after the server
          refuses it — `invoices.member_id` is NOT NULL, so a walk-in has no
          account to charge. */}
      {tenders.some((t) => t.method === 'account') && !memberPicked ? (
        <p className="border-t border-line-10 bg-wash-flare px-3 py-2 text-[12px] text-foam-80">
          An account charge needs a member. Attach one above, or take another tender.
        </p>
      ) : null}
    </div>
  );
}

/* — Receipt — */

function Receipt({ detail, onNewSale }: { detail: PosOrderDetail; onNewSale: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-line bg-wash-kelp px-3 py-3">
        <div className="flex items-center gap-2 text-kelp">
          <span aria-hidden="true">✓</span>
          <Display size="sm" as="h2">
            Sold
          </Display>
        </div>
        <p className="mt-1 text-[13px] text-foam-80">
          Receipt {detail.order.reference} · {money(detail.order.totalMinor)} taken.
        </p>
        {detail.order.invoiceId ? (
          <p className="mt-1 text-[12px] text-foam-65">
            The on-account share was invoiced to {detail.order.memberName ?? 'the member'}.
          </p>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <ul>
          {detail.lines.map((line) => (
            <li key={line.id} className="flex items-center gap-2 border-b border-line-10 px-3 py-2 text-[13px]">
              <span className="w-8 tabular-nums text-foam-45">{line.quantity}×</span>
              <span className="min-w-0 flex-1 truncate">{line.name}</span>
              <span className="tabular-nums">{money(line.totalMinor)}</span>
            </li>
          ))}
        </ul>
        <ul className="border-t border-line">
          {detail.tenders.map((tender) => (
            <li
              key={tender.id}
              className="flex items-center gap-2 border-b border-line-10 px-3 py-2 text-[12px] text-foam-65"
            >
              <span className="flex-1">
                {TENDER_LABEL[tender.method]}
                {tender.reference ? ` · ${tender.reference}` : ''}
              </span>
              <span className="tabular-nums">{money(tender.amountMinor)}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex-none border-t border-line p-3">
        <Button variant="cta" full size="md" onClick={onNewSale}>
          New sale
        </Button>
      </div>
    </div>
  );
}
