import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ProductGroup,
  StockLedgerPage,
  StoreFinancialAccess,
  StoreProduct,
  Supplier,
} from '@shark/contracts';
import { ApiError, api } from '../../lib/api';
import {
  Button,
  Chip,
  EmptyState,
  Label,
  Panel,
  Segmented,
  Skeleton,
  TD,
  TH,
  THead,
  TR,
  Table,
  TableScroll,
  Toolbar,
} from '../../ui/console';
import { Drawer } from '../../ui/overlay';
import { MOVEMENT_LABEL, Money, StockChip, dateTime, money } from './shared';

/* ============================================================================
   Inventory (PF-POS-001, PF-POS-003).

   The table is the screen. Everything that edits a product happens in a drawer
   over it, so the list a manager is comparing against never goes away — a
   stocktake is a comparison, and paging to a form loses the thing you were
   comparing to.
   ========================================================================= */

type Filter = 'all' | 'low' | 'retired';

export default function Inventory({
  products,
  financial,
  loading,
  branchId,
  canManage,
}: {
  products: StoreProduct[];
  financial: StoreFinancialAccess | undefined;
  loading: boolean;
  branchId: string | null;
  canManage: boolean;
}) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [filter, setFilter] = useState<Filter>('all');
  const [detail, setDetail] = useState<StoreProduct | null>(null);
  const [editing, setEditing] = useState<StoreProduct | 'new' | null>(null);
  const [managingSuppliers, setManagingSuppliers] = useState(false);

  const categories = useMemo(
    () => [...new Set(products.map((p) => p.category))].filter(Boolean).sort(),
    [products],
  );

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return products.filter((p) => {
      if (filter === 'low' && !p.lowStock) return false;
      if (filter === 'retired' ? p.active : !p.active) return false;
      if (category !== 'all' && p.category !== category) return false;
      if (!needle) return true;
      return (
        p.displayName.toLowerCase().includes(needle) ||
        p.sku.toLowerCase().includes(needle) ||
        (p.barcode ?? '').toLowerCase().includes(needle) ||
        (p.supplierName ?? '').toLowerCase().includes(needle)
      );
    });
  }, [products, search, category, filter]);

  return (
    <>
      <Toolbar>
        <label className="flex min-w-0 flex-1 items-center gap-2">
          <span className="sr-only">Search inventory</span>
          <input
            className="sf-field !min-h-9 !text-[13px]"
            placeholder="Name, SKU, barcode or supplier"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>

        <label className="flex items-center gap-1.5">
          <span className="font-utility text-[9px] uppercase tracking-[0.14em] text-foam-45">Category</span>
          <select
            className="min-h-9 border border-line bg-panel px-2 text-[12px] text-foam"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="all">All</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>

        <Segmented
          label="Stock filter"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'Active' },
            { value: 'low', label: 'Low stock' },
            { value: 'retired', label: 'Retired' },
          ]}
        />

        {canManage ? (
          <>
            <Button onClick={() => setManagingSuppliers(true)}>Suppliers</Button>
            <Button variant="cta" onClick={() => setEditing('new')}>
              New product
            </Button>
          </>
        ) : null}
      </Toolbar>

      <Panel>
        {loading ? (
          <Skeleton className="m-4 h-64" />
        ) : rows.length === 0 ? (
          <EmptyState
            title="Nothing matches"
            body={
              products.length === 0
                ? 'No products yet. Add the first one to start selling from this shop.'
                : 'No product matches these filters. Clear the search or switch back to Active.'
            }
            action={
              canManage && products.length === 0 ? (
                <Button variant="cta" onClick={() => setEditing('new')}>
                  New product
                </Button>
              ) : null
            }
          />
        ) : (
          <TableScroll className="max-h-[calc(100vh-230px)]">
            <Table>
              <THead>
                <TH>Item</TH>
                <TH>SKU</TH>
                <TH>Supplier</TH>
                <TH align="right">Stock</TH>
                <TH align="right">Reorder at</TH>
                <TH align="right">Price</TH>
                <TH align="right">Cost</TH>
                <TH align="right">Stock value</TH>
                <TH align="right">Actions</TH>
              </THead>
              <tbody>
                {rows.map((product) => (
                  <TR key={product.id} selected={detail?.id === product.id} onClick={() => setDetail(product)}>
                    <TD>
                      <div className="max-w-[26ch] truncate">{product.displayName}</div>
                      <div className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
                        {product.category}
                        {product.groupName ? ` · ${product.groupName}` : ''}
                        {product.active ? '' : ' · retired'}
                      </div>
                    </TD>
                    <TD className="font-utility text-[11px] text-foam-50">{product.sku}</TD>
                    <TD className="text-foam-65">{product.supplierName ?? '—'}</TD>
                    <TD numeric>
                      <StockChip onHand={product.onHand} lowStock={product.lowStock} />
                    </TD>
                    <TD numeric className="text-foam-45">
                      {product.reorderAt}
                    </TD>
                    <TD numeric>{money(product.priceMinor)}</TD>
                    <TD numeric className="text-foam-65">
                      <Money minor={product.costMinor} />
                    </TD>
                    <TD numeric className="text-foam-65">
                      <Money minor={product.valuationMinor} />
                    </TD>
                    <TD align="right">
                      <Button
                        onClick={(e) => {
                          e.stopPropagation();
                          setDetail(product);
                        }}
                      >
                        Open
                      </Button>
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        )}
      </Panel>

      <ProductDrawer
        product={detail}
        branchId={branchId}
        canManage={canManage}
        financial={financial}
        onClose={() => setDetail(null)}
        onEdit={(p) => {
          setDetail(null);
          setEditing(p);
        }}
      />

      <ProductForm
        target={editing}
        canManage={canManage}
        onClose={() => setEditing(null)}
      />

      <SupplierDrawer open={managingSuppliers} onClose={() => setManagingSuppliers(false)} canManage={canManage} />
    </>
  );
}

/* — Detail: stock, movement ledger and adjustment ——————————————— */

function ProductDrawer({
  product,
  branchId,
  canManage,
  financial,
  onClose,
  onEdit,
}: {
  product: StoreProduct | null;
  branchId: string | null;
  canManage: boolean;
  financial: StoreFinancialAccess | undefined;
  onClose: () => void;
  onEdit: (product: StoreProduct) => void;
}) {
  const queryClient = useQueryClient();
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState<'purchase' | 'adjustment' | 'damage'>('purchase');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const ledger = useQuery({
    queryKey: ['store', 'ledger', product?.id, branchId],
    queryFn: () =>
      api<StockLedgerPage>(
        `/admin/store/products/${product!.id}/ledger${branchId ? `?branchId=${encodeURIComponent(branchId)}` : ''}`,
      ),
    enabled: product !== null,
  });

  const adjust = useMutation({
    mutationFn: () =>
      api(`/admin/store/products/${product!.id}/stock`, {
        method: 'POST',
        body: {
          branchId,
          delta: Number.parseInt(delta, 10),
          reason,
          note: note.trim() || null,
        },
      }),
    onSuccess: () => {
      setDelta('');
      setNote('');
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['store'] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'The adjustment did not save.'),
  });

  if (!product) return null;

  const parsed = Number.parseInt(delta, 10);
  const canSubmit =
    canManage && branchId !== null && !Number.isNaN(parsed) && parsed !== 0 && !adjust.isPending;

  return (
    <Drawer
      open
      onClose={onClose}
      kicker={product.sku}
      title={product.displayName}
      footer={
        canManage ? (
          <Button full onClick={() => onEdit(product)}>
            Edit product
          </Button>
        ) : null
      }
    >
      <dl className="grid grid-cols-2 gap-px bg-line">
        <Fact label="On hand" value={String(product.onHand)} />
        <Fact label="Reorder at" value={String(product.reorderAt)} />
        <Fact label="Price" value={money(product.priceMinor)} />
        <Fact label="Tax" value={`${(product.taxRateBp / 100).toFixed(0)}%`} />
        <Fact label="Cost" value={product.costMinor === null ? null : money(product.costMinor)} />
        <Fact
          label="Stock value"
          value={product.valuationMinor === null ? null : money(product.valuationMinor)}
        />
        <Fact label="Supplier" value={product.supplierName ?? '—'} />
        <Fact label="Barcode" value={product.barcode ?? '—'} />
      </dl>

      {canManage ? (
        <section className="border-t border-line p-3">
          <Label>Adjust stock</Label>
          {branchId === null ? (
            <p className="mt-1.5 text-[12px] text-foam-65">
              Stock belongs to a branch. Pick one in the bar above to adjust it.
            </p>
          ) : (
            <div className="mt-2 flex flex-col gap-2">
              <div className="flex items-end gap-2">
                <label className="flex flex-col gap-1">
                  <span className="font-utility text-[9px] uppercase tracking-[0.14em] text-foam-45">
                    Change
                  </span>
                  <input
                    type="number"
                    value={delta}
                    onChange={(e) => setDelta(e.target.value)}
                    placeholder="e.g. 12 or −3"
                    aria-label="Stock change, positive to add or negative to remove"
                    className="sf-field !min-h-9 !w-28 !text-right !text-[13px] tabular-nums"
                  />
                </label>
                <div className="flex-1">
                  <span className="font-utility text-[9px] uppercase tracking-[0.14em] text-foam-45">
                    Reason
                  </span>
                  <div className="mt-1">
                    <Segmented
                      label="Adjustment reason"
                      value={reason}
                      onChange={setReason}
                      options={[
                        { value: 'purchase', label: 'Purchase' },
                        { value: 'adjustment', label: 'Correction' },
                        { value: 'damage', label: 'Damage' },
                      ]}
                    />
                  </div>
                </div>
              </div>

              <input
                className="sf-field !min-h-9 !text-[13px]"
                placeholder="Note — what happened, for the ledger"
                value={note}
                aria-label="Adjustment note"
                onChange={(e) => setNote(e.target.value)}
              />

              {error ? (
                <p role="alert" className="text-[12px] text-chum">
                  {error}
                </p>
              ) : null}

              <Button variant="cta" disabled={!canSubmit} onClick={() => adjust.mutate()}>
                {adjust.isPending
                  ? 'Recording…'
                  : Number.isNaN(parsed) || parsed === 0
                    ? 'Enter a change'
                    : `Record ${parsed > 0 ? `+${parsed}` : parsed}`}
              </Button>
              <p className="text-[11px] leading-relaxed text-foam-45">
                Stock is never edited in place. This writes one line to the ledger below, with your
                name against it.
              </p>
            </div>
          )}
        </section>
      ) : null}

      <section className="border-t border-line">
        <div className="flex items-center gap-2 px-3 py-2">
          <Label>Movement ledger</Label>
          <span className="flex-1" />
          <span className="font-utility text-[9px] uppercase tracking-[0.12em] text-foam-35">
            Newest first
          </span>
        </div>
        {ledger.isLoading ? (
          <Skeleton className="m-3 h-32" />
        ) : (ledger.data?.items ?? []).length === 0 ? (
          <p className="px-3 pb-3 text-[13px] text-foam-65">
            Nothing has moved yet. Purchases, sales and corrections all land here.
          </p>
        ) : (
          <TableScroll className="max-h-[320px]">
            <Table>
              <THead>
                <TH align="right">Change</TH>
                <TH>Reason</TH>
                <TH>Who</TH>
                <TH>When</TH>
                {financial?.canSeeCost ? <TH align="right">Unit cost</TH> : null}
              </THead>
              <tbody>
                {(ledger.data?.items ?? []).map((row) => (
                  <TR key={row.id}>
                    <TD numeric className={row.delta < 0 ? 'text-chum' : 'text-kelp'}>
                      {row.delta > 0 ? `+${row.delta}` : row.delta}
                    </TD>
                    <TD>
                      <span className="text-[12px]">{MOVEMENT_LABEL[row.reason] ?? row.reason}</span>
                      {row.negativeOverride ? (
                        <Chip tone="warn" className="ml-1.5">
                          Override
                        </Chip>
                      ) : null}
                      {row.note ? (
                        <div className="max-w-[24ch] truncate text-[11px] text-foam-45">{row.note}</div>
                      ) : null}
                    </TD>
                    <TD className="text-[12px] text-foam-65">{row.actorName}</TD>
                    <TD className="whitespace-nowrap text-[11px] text-foam-45">{dateTime(row.at)}</TD>
                    {financial?.canSeeCost ? (
                      <TD numeric className="text-foam-65">
                        <Money minor={row.unitCostMinor} />
                      </TD>
                    ) : null}
                  </TR>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        )}
      </section>
    </Drawer>
  );
}

function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="bg-panel px-3 py-2">
      <dt className="font-utility text-[9px] uppercase tracking-[0.14em] text-foam-45">{label}</dt>
      <dd className="mt-0.5 text-[13px] tabular-nums">
        {value === null ? <Money minor={null} /> : value}
      </dd>
    </div>
  );
}

/* — Create and edit ————————————————————————————————————————————— */

interface ProductDraft {
  name: string;
  sku: string;
  barcode: string;
  category: string;
  variantName: string;
  supplierId: string;
  groupId: string;
  priceMinor: number;
  costMinor: number;
  taxRateBp: number;
  reorderAt: number;
  active: boolean;
}

const emptyDraft: ProductDraft = {
  name: '',
  sku: '',
  barcode: '',
  category: '',
  variantName: '',
  supplierId: '',
  groupId: '',
  priceMinor: 0,
  costMinor: 0,
  taxRateBp: 1800,
  reorderAt: 5,
  active: true,
};

function ProductForm({
  target,
  canManage,
  onClose,
}: {
  target: StoreProduct | 'new' | null;
  canManage: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const isNew = target === 'new';
  const [draft, setDraft] = useState<ProductDraft>(emptyDraft);
  const [error, setError] = useState<string | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  const suppliers = useQuery({
    queryKey: ['store', 'suppliers'],
    queryFn: () => api<{ items: Supplier[] }>('/admin/store/suppliers'),
    enabled: target !== null,
  });
  const groups = useQuery({
    queryKey: ['store', 'groups'],
    queryFn: () => api<{ items: ProductGroup[] }>('/admin/store/groups'),
    enabled: target !== null,
  });

  // Seed the form from the record being edited, once per record — a later
  // render pass must not clobber what the operator has typed.
  const existing = target !== null && target !== 'new' ? target : null;
  const key = target === null ? null : (existing?.id ?? 'new');
  if (key !== null && key !== loadedFor) {
    setLoadedFor(key);
    setDraft(
      existing === null
        ? emptyDraft
        : {
            name: existing.name,
            sku: existing.sku,
            barcode: existing.barcode ?? '',
            category: existing.category,
            variantName: existing.variantName,
            supplierId: existing.supplierId ?? '',
            groupId: existing.groupId ?? '',
            priceMinor: existing.priceMinor,
            // Withheld from a role without `inventory.manage`, but this form is
            // only reachable with it, so a null here is a new product.
            costMinor: existing.costMinor ?? 0,
            taxRateBp: existing.taxRateBp,
            reorderAt: existing.reorderAt,
            active: existing.active,
          },
    );
    setError(null);
  }

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: draft.name.trim(),
        sku: draft.sku.trim(),
        barcode: draft.barcode.trim() || null,
        category: draft.category.trim(),
        variantName: draft.variantName.trim() || null,
        supplierId: draft.supplierId || null,
        groupId: draft.groupId || null,
        priceMinor: draft.priceMinor,
        costMinor: draft.costMinor,
        taxRateBp: draft.taxRateBp,
        reorderAt: draft.reorderAt,
        ...(isNew ? {} : { active: draft.active }),
      };
      return existing === null
        ? api('/admin/store/products', { method: 'POST', body })
        : api(`/admin/store/products/${existing.id}`, { method: 'PATCH', body });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['store'] });
      onClose();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'That did not save.'),
  });

  if (target === null || !canManage) return null;

  const ready = draft.name.trim().length > 0 && draft.sku.trim().length > 0 && draft.category.trim().length > 0;

  return (
    <Drawer
      open
      onClose={onClose}
      kicker={isNew ? 'Catalogue' : draft.sku}
      title={isNew ? 'New product' : draft.name}
      footer={
        <div className="flex items-center gap-2">
          <Button variant="cta" full disabled={!ready || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : isNew ? 'Add to catalogue' : 'Save changes'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3 p-3">
        <Text label="Name" value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} />
        <div className="grid grid-cols-2 gap-3">
          <Text label="SKU" value={draft.sku} onChange={(v) => setDraft({ ...draft, sku: v })} />
          <Text
            label="Variant"
            hint="Size or colour. Leave blank if there is only one."
            value={draft.variantName}
            onChange={(v) => setDraft({ ...draft, variantName: v })}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Text label="Category" value={draft.category} onChange={(v) => setDraft({ ...draft, category: v })} />
          <Text
            label="Barcode"
            hint="Must be unique — a scanner cannot ask which you meant."
            value={draft.barcode}
            onChange={(v) => setDraft({ ...draft, barcode: v })}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Rupees label="Price" value={draft.priceMinor} onChange={(v) => setDraft({ ...draft, priceMinor: v })} />
          <Rupees label="Cost" value={draft.costMinor} onChange={(v) => setDraft({ ...draft, costMinor: v })} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Num
            label="Tax %"
            value={draft.taxRateBp / 100}
            onChange={(v) => setDraft({ ...draft, taxRateBp: Math.round(v * 100) })}
          />
          <Num
            label="Reorder at"
            hint="Flags as low stock at or below this."
            value={draft.reorderAt}
            onChange={(v) => setDraft({ ...draft, reorderAt: Math.round(v) })}
          />
        </div>

        <Select
          label="Supplier"
          value={draft.supplierId}
          onChange={(v) => setDraft({ ...draft, supplierId: v })}
          options={(suppliers.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }))}
        />
        <Select
          label="Product group"
          hint="Groups variants of one product together."
          value={draft.groupId}
          onChange={(v) => setDraft({ ...draft, groupId: v })}
          options={(groups.data?.items ?? []).map((g) => ({ value: g.id, label: g.name }))}
        />

        {!isNew ? (
          <label className="flex items-center gap-2 border-t border-line-10 pt-3">
            <input
              type="checkbox"
              checked={draft.active}
              onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
            />
            <span className="text-[13px]">
              On sale
              <span className="ml-1.5 text-foam-45">
                — a retired product cannot be sold, but its stock still returns.
              </span>
            </span>
          </label>
        ) : null}

        {error ? (
          <p role="alert" className="bg-wash-chum p-2 text-[12px] text-foam-80">
            {error}
          </p>
        ) : null}
      </div>
    </Drawer>
  );
}

/* — Suppliers ——————————————————————————————————————————————————— */

function SupplierDrawer({
  open,
  onClose,
  canManage,
}: {
  open: boolean;
  onClose: () => void;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [contactName, setContactName] = useState('');
  const [phone, setPhone] = useState('');
  const [leadTimeDays, setLeadTimeDays] = useState(7);
  const [error, setError] = useState<string | null>(null);

  const suppliers = useQuery({
    queryKey: ['store', 'suppliers'],
    queryFn: () => api<{ items: Supplier[] }>('/admin/store/suppliers'),
    enabled: open,
  });

  const create = useMutation({
    mutationFn: () =>
      api('/admin/store/suppliers', {
        method: 'POST',
        body: { name: name.trim(), contactName: contactName.trim(), phone: phone.trim(), leadTimeDays },
      }),
    onSuccess: () => {
      setName('');
      setContactName('');
      setPhone('');
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['store', 'suppliers'] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'That did not save.'),
  });

  if (!open) return null;

  return (
    <Drawer open onClose={onClose} kicker="Catalogue" title="Suppliers">
      {(suppliers.data?.items ?? []).length === 0 ? (
        <EmptyState title="No suppliers yet" body="Add who you buy from, so reordering knows where to go." />
      ) : (
        <TableScroll>
          <Table>
            <THead>
              <TH>Supplier</TH>
              <TH>Contact</TH>
              <TH align="right">Lead time</TH>
            </THead>
            <tbody>
              {(suppliers.data?.items ?? []).map((s) => (
                <TR key={s.id}>
                  <TD>{s.name}</TD>
                  <TD className="text-foam-65">
                    {s.contactName || '—'}
                    {s.phone ? (
                      <div className="text-[11px] text-foam-45">{s.phone}</div>
                    ) : null}
                  </TD>
                  <TD numeric className="text-foam-65">
                    {s.leadTimeDays}d
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </TableScroll>
      )}

      {canManage ? (
        <section className="border-t border-line p-3">
          <Label>Add a supplier</Label>
          <div className="mt-2 flex flex-col gap-2.5">
            <Text label="Name" value={name} onChange={setName} />
            <div className="grid grid-cols-2 gap-3">
              <Text label="Contact" value={contactName} onChange={setContactName} />
              <Text label="Phone" value={phone} onChange={setPhone} />
            </div>
            <Num label="Lead time (days)" value={leadTimeDays} onChange={(v) => setLeadTimeDays(Math.round(v))} />
            {error ? (
              <p role="alert" className="text-[12px] text-chum">
                {error}
              </p>
            ) : null}
            <Button
              variant="cta"
              disabled={name.trim().length === 0 || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending ? 'Saving…' : 'Add supplier'}
            </Button>
          </div>
        </section>
      ) : null}
    </Drawer>
  );
}

/* — Small form controls ————————————————————————————————————————— */

function Text({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
}) {
  const id = `sf_${label.replace(/\W+/g, '_').toLowerCase()}`;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="font-utility text-[9px] uppercase tracking-[0.14em] text-foam-45">
        {label}
      </label>
      <input id={id} className="sf-field !min-h-9 !text-[13px]" value={value} onChange={(e) => onChange(e.target.value)} />
      {hint ? <p className="text-[10px] leading-snug text-foam-35">{hint}</p> : null}
    </div>
  );
}

function Num({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  hint?: string;
}) {
  const id = `sf_${label.replace(/\W+/g, '_').toLowerCase()}`;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="font-utility text-[9px] uppercase tracking-[0.14em] text-foam-45">
        {label}
      </label>
      <input
        id={id}
        type="number"
        className="sf-field !min-h-9 !text-right !text-[13px] tabular-nums"
        value={value}
        onChange={(e) => {
          const next = Number.parseFloat(e.target.value);
          onChange(Number.isNaN(next) ? 0 : next);
        }}
      />
      {hint ? <p className="text-[10px] leading-snug text-foam-35">{hint}</p> : null}
    </div>
  );
}

/** Rupees in, minor units out — the operator never types a paisa count. */
function Rupees({ label, value, onChange }: { label: string; value: number; onChange: (minor: number) => void }) {
  const id = `sf_${label.replace(/\W+/g, '_').toLowerCase()}`;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="font-utility text-[9px] uppercase tracking-[0.14em] text-foam-45">
        {label} (₹)
      </label>
      <input
        id={id}
        type="number"
        min={0}
        step="1"
        className="sf-field !min-h-9 !text-right !text-[13px] tabular-nums"
        value={value / 100}
        onChange={(e) => {
          const rupees = Number.parseFloat(e.target.value);
          onChange(Number.isNaN(rupees) ? 0 : Math.round(rupees * 100));
        }}
      />
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  hint?: string;
}) {
  const id = `sf_${label.replace(/\W+/g, '_').toLowerCase()}`;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="font-utility text-[9px] uppercase tracking-[0.14em] text-foam-45">
        {label}
      </label>
      <select
        id={id}
        className="min-h-9 border border-line bg-panel px-2 text-[13px] text-foam"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">None</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint ? <p className="text-[10px] leading-snug text-foam-35">{hint}</p> : null}
    </div>
  );
}
