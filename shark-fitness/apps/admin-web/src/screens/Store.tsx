import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, OfflineError, api, idempotencyKey } from '../lib/api';
import { useBranchScope, usePermission } from '../lib/store';
import { useOnline } from '../lib/realtime';
import { Page } from '../ui/shell';
import {
  Button,
  Chip,
  EmptyState,
  ErrorState,
  Field,
  Label,
  Metric,
  Panel,
  PermissionState,
  Skeleton,
  Toolbar,
  cx,
  type Tone,
} from '../ui/console';

interface ProductRow {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  category: string;
  variantName: string;
  groupName: string | null;
  supplierName: string | null;
  priceMinor: number;
  costMinor: number;
  taxRateBp: number;
  reorderAt: number;
  active: boolean;
  onHand: number;
  lowStock: boolean;
  valuationMinor: number;
}

interface OrderRow {
  id: string;
  reference: string;
  branchId: string;
  memberId: string | null;
  totalMinor: number;
  state: string;
  kind: string;
  staffName: string;
  createdAt: number;
}

interface TransferRow {
  id: string;
  reference: string;
  fromBranchId: string;
  toBranchId: string;
  state: string;
  createdAt: number;
}

interface ReportBody {
  sales: { orders: number; returns: number; voided: number; unitsSold: number; revenueMinor: number; taxMinor: number };
  margin: { revenueMinor: number; costMinor: number; marginMinor: number; marginBp: number };
  valuation: { valuationMinor: number; skus: number };
  shrinkage: { units: number; costMinor: number };
  lowStock: Array<{ id: string; name: string; sku: string; onHand: number; reorderAt: number }>;
  topProducts: Array<{ productId: string; name: string; units: number; revenueMinor: number; marginMinor: number }>;
}

type PaymentMethod = 'cash' | 'card' | 'upi' | 'account';

const money = (minor: number): string =>
  `${minor < 0 ? '−' : ''}₹${Math.abs(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const stateTone: Record<string, Tone> = {
  paid: 'good',
  returned: 'warn',
  partially_returned: 'warn',
  voided: 'bad',
  draft: 'neutral',
  dispatched: 'warn',
  received: 'good',
  cancelled: 'bad',
};

interface BasketLine {
  product: ProductRow;
  quantity: number;
  discountMinor: number;
}

export default function StoreScreen() {
  const canView = usePermission('inventory.view');
  const canManage = usePermission('inventory.manage');
  const { branchId, branchName } = useBranchScope();
  const online = useOnline();
  const queryClient = useQueryClient();

  const [basket, setBasket] = useState<BasketLine[]>([]);
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [search, setSearch] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);

  const scope = branchId ? `?branchId=${encodeURIComponent(branchId)}` : '';

  const products = useQuery({
    queryKey: ['store', 'products', branchId],
    queryFn: () => api<{ items: ProductRow[] }>(`/admin/store/products${scope}`),
    enabled: canView,
  });
  const orders = useQuery({
    queryKey: ['store', 'orders', branchId],
    queryFn: () => api<{ items: OrderRow[] }>(`/admin/store/orders${scope}`),
    enabled: canView,
  });
  const transfers = useQuery({
    queryKey: ['store', 'transfers'],
    queryFn: () => api<{ items: TransferRow[] }>('/admin/store/transfers'),
    enabled: canView,
  });
  const report = useQuery({
    queryKey: ['store', 'reports', branchId],
    queryFn: () => api<ReportBody>(`/admin/store/reports${scope}`),
    enabled: canView,
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['store'] });
  };

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

  const sell = useMutation({
    mutationFn: () =>
      api<{ order: { reference: string } }>('/admin/store/orders', {
        method: 'POST',
        idempotencyKey: idempotencyKey('pos', branchId ?? 'all', basket.length, totals.total),
        body: {
          branchId,
          lines: basket.map((l) => ({
            productId: l.product.id,
            quantity: l.quantity,
            discountMinor: l.discountMinor,
          })),
          payments: [{ method, amountMinor: totals.total }],
        },
      }),
    onSuccess: (result) => {
      setReceipt(result.order.reference);
      setBasket([]);
      setError(null);
      refresh();
    },
    onError: (e) => {
      if (e instanceof OfflineError) setError('No connection. The sale was not taken.');
      else setError(e instanceof ApiError ? e.message : 'That did not work.');
    },
  });

  const receiveTransfer = useMutation({
    mutationFn: (transferId: string) =>
      api(`/admin/store/transfers/${transferId}/receive`, { method: 'POST', body: { lines: [] } }),
    onSuccess: refresh,
    onError: (e) => setError(e instanceof ApiError ? e.message : 'That did not work.'),
  });

  // Every hook above runs on each render; the permission gate comes after them
  // so the hook count never changes when the permission resolves.
  if (!canView) {
    return (
      <Page title="Store">
        <PermissionState what="The store" />
      </Page>
    );
  }

  if (products.isLoading) {
    return (
      <Page title="Store" kicker="Loading">
        <Skeleton className="m-4 h-64" />
      </Page>
    );
  }

  if (products.error || !products.data) {
    return (
      <Page title="Store">
        <ErrorState
          title="Could not load the store"
          body="The API did not answer. Nothing has been sold."
          onRetry={() => void products.refetch()}
        />
      </Page>
    );
  }

  const items = products.data.items.filter((p) => {
    if (lowOnly && !p.lowStock) return false;
    if (!search.trim()) return true;
    const needle = search.trim().toLowerCase();
    return (
      p.name.toLowerCase().includes(needle) ||
      p.sku.toLowerCase().includes(needle) ||
      (p.barcode ?? '').includes(needle)
    );
  });

  const addToBasket = (product: ProductRow): void => {
    setReceipt(null);
    setBasket((current) => {
      const existing = current.find((l) => l.product.id === product.id);
      if (existing) {
        return current.map((l) => (l.product.id === product.id ? { ...l, quantity: l.quantity + 1 } : l));
      }
      return [...current, { product, quantity: 1, discountMinor: 0 }];
    });
  };

  const setQuantity = (productId: string, quantity: number): void => {
    setBasket((current) =>
      quantity <= 0
        ? current.filter((l) => l.product.id !== productId)
        : current.map((l) => (l.product.id === productId ? { ...l, quantity } : l)),
    );
  };

  const openTransfers = (transfers.data?.items ?? []).filter((t) => t.state === 'dispatched');
  const metrics = report.data;

  return (
    <Page
      title="Store"
      kicker={`${branchName} · ${items.length} SKUs`}
      actions={
        <Toolbar>
          <Field
            label="Search"
            placeholder="Name, SKU or barcode"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Button variant={lowOnly ? 'cta' : 'outline'} onClick={() => setLowOnly(!lowOnly)}>
            {lowOnly ? 'Showing low stock' : 'Low stock only'}
          </Button>
        </Toolbar>
      }
    >
      {!online ? (
        <Panel tone="warn" className="mx-4 mt-4 p-3">
          <p className="text-[13px] text-foam-80">
            Offline. The register needs a connection to take a sale — stock figures below may be stale.
          </p>
        </Panel>
      ) : null}

      {error ? (
        <Panel tone="bad" className="mx-4 mt-4 p-3">
          <p className="text-[13px] text-foam-80">{error}</p>
        </Panel>
      ) : null}

      {receipt ? (
        <Panel tone="good" className="mx-4 mt-4 p-3">
          <p className="text-[13px] text-foam-80">Sold. Receipt {receipt}.</p>
        </Panel>
      ) : null}

      {metrics ? (
        <div className="grid grid-cols-2 gap-px bg-line md:grid-cols-5">
          <Panel className="p-3">
            <Label>Revenue</Label>
            <Metric value={money(metrics.margin.revenueMinor)} />
          </Panel>
          <Panel className="p-3">
            <Label>Margin</Label>
            <Metric value={money(metrics.margin.marginMinor)} unit={`${(metrics.margin.marginBp / 100).toFixed(1)}%`} />
          </Panel>
          <Panel className="p-3">
            <Label>Stock value</Label>
            <Metric value={money(metrics.valuation.valuationMinor)} />
          </Panel>
          <Panel className="p-3">
            <Label>Shrinkage</Label>
            <Metric value={money(metrics.shrinkage.costMinor)} unit={`${metrics.shrinkage.units} units`} />
          </Panel>
          <Panel className="p-3">
            <Label>Low stock</Label>
            <Metric value={String(metrics.lowStock.length)} unit="to reorder" />
          </Panel>
        </div>
      ) : null}

      <div className="grid gap-px bg-line lg:grid-cols-[1.6fr_1fr]">
        <Panel title={`Catalogue · ${items.length}`}>
          {items.length === 0 ? (
            <EmptyState title="Nothing matches" body="No product matches that search at this branch." />
          ) : (
            <div className="max-h-[460px] overflow-y-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-left text-foam-50">
                    <th className="px-3 py-2">Item</th>
                    <th className="px-3 py-2">Stock</th>
                    <th className="px-3 py-2">Price</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((p) => (
                    <tr key={p.id} className="border-t border-line-10">
                      <td className="px-3 py-2">
                        <div>{p.variantName ? `${p.name} — ${p.variantName}` : p.name}</div>
                        <div className="text-[11px] text-foam-50">
                          {p.sku}
                          {p.supplierName ? ` · ${p.supplierName}` : ''}
                          {p.active ? '' : ' · retired'}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <Chip tone={p.onHand <= 0 ? 'bad' : p.lowStock ? 'warn' : 'good'}>{p.onHand}</Chip>
                      </td>
                      <td className="px-3 py-2">{money(p.priceMinor)}</td>
                      <td className="px-3 py-2 text-right">
                        <Button
                          disabled={!canManage || !branchId || !p.active || p.onHand <= 0}
                          onClick={() => addToBasket(p)}
                        >
                          Add
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title="Register">
          {!canManage ? (
            <div className="p-3">
              <p className="text-[13px] text-foam-65">
                Your role can read the store but not take a sale.
              </p>
            </div>
          ) : !branchId ? (
            <div className="p-3">
              <p className="text-[13px] text-foam-65">
                A till belongs to one branch. Pick a branch above to ring up a sale — the
                catalogue below is showing stock across all {branchName.match(/\d+/)?.[0] ?? 'your'} branches.
              </p>
            </div>
          ) : basket.length === 0 ? (
            <EmptyState title="No sale in progress" body="Add an item from the catalogue to start." />
          ) : (
            <div className="flex flex-col gap-3 p-3">
              {basket.map((line) => (
                <div key={line.product.id} className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-[13px]">
                      {line.product.variantName ? `${line.product.name} — ${line.product.variantName}` : line.product.name}
                    </div>
                    <div className="text-[11px] text-foam-50">{money(line.product.priceMinor)} each</div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button onClick={() => setQuantity(line.product.id, line.quantity - 1)}>−</Button>
                    <span className="w-6 text-center text-[13px]">{line.quantity}</span>
                    <Button
                      disabled={line.quantity >= line.product.onHand}
                      onClick={() => setQuantity(line.product.id, line.quantity + 1)}
                    >
                      +
                    </Button>
                  </div>
                </div>
              ))}

              <div className="border-t border-line-10 pt-2 text-[13px]">
                <div className="flex justify-between text-foam-65">
                  <span>Subtotal</span>
                  <span>{money(totals.subtotal)}</span>
                </div>
                <div className="flex justify-between text-foam-65">
                  <span>Tax</span>
                  <span>{money(totals.tax)}</span>
                </div>
                <div className="mt-1 flex justify-between font-semibold">
                  <span>Total</span>
                  <span>{money(totals.total)}</span>
                </div>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {(['cash', 'card', 'upi', 'account'] as const).map((m) => (
                  <Button key={m} variant={method === m ? 'cta' : 'outline'} onClick={() => setMethod(m)}>
                    {m}
                  </Button>
                ))}
              </div>

              <Button
                variant="cta"
                full
                disabled={!online || sell.isPending || totals.total <= 0}
                onClick={() => sell.mutate()}
              >
                {sell.isPending ? 'Taking payment…' : `Take ${money(totals.total)}`}
              </Button>
            </div>
          )}
        </Panel>
      </div>

      <div className="grid gap-px bg-line lg:grid-cols-2">
        <Panel title={`Recent sales · ${orders.data?.items.length ?? 0}`}>
          {orders.isLoading ? (
            <Skeleton className="m-3 h-32" />
          ) : (orders.data?.items ?? []).length === 0 ? (
            <EmptyState title="No sales yet" body="Sales taken at this branch will appear here." />
          ) : (
            <div className="max-h-[260px] overflow-y-auto">
              {(orders.data?.items ?? []).map((o) => (
                <div key={o.id} className="flex items-center justify-between border-b border-line-10 px-3 py-2 text-[13px]">
                  <div>
                    <div>{o.reference}</div>
                    <div className="text-[11px] text-foam-50">
                      {o.staffName} · {new Date(o.createdAt).toLocaleTimeString('en-IN')}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Chip tone={stateTone[o.state] ?? 'neutral'}>{o.kind === 'return' ? 'return' : o.state}</Chip>
                    <span className={cx(o.totalMinor < 0 && 'text-chum')}>{money(o.totalMinor)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title={`Transfers · ${openTransfers.length} in transit`}>
          {(transfers.data?.items ?? []).length === 0 ? (
            <EmptyState title="No transfers" body="Stock moving between branches will appear here." />
          ) : (
            <div className="max-h-[260px] overflow-y-auto">
              {(transfers.data?.items ?? []).map((t) => (
                <div key={t.id} className="flex items-center justify-between border-b border-line-10 px-3 py-2 text-[13px]">
                  <div>
                    <div>{t.reference}</div>
                    <div className="text-[11px] text-foam-50">
                      {t.fromBranchId} → {t.toBranchId}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Chip tone={stateTone[t.state] ?? 'neutral'}>{t.state}</Chip>
                    {t.state === 'dispatched' && canManage ? (
                      <Button disabled={receiveTransfer.isPending} onClick={() => receiveTransfer.mutate(t.id)}>
                        Receive
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </Page>
  );
}
