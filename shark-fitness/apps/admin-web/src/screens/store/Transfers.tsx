import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { StockTransfer, StockTransferDetail, StoreProduct } from '@shark/contracts';
import { ApiError, api } from '../../lib/api';
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
import { TransferStateChip, dateTime } from './shared';

/* ============================================================================
   Inter-branch transfer (PF-POS-005).

   Dispatch and receipt are two acts because stock in a van belongs to neither
   branch's shelf, and this screen keeps them two. The receipt step counts each
   line rather than accepting the paperwork: whatever did not turn up is written
   off as shrinkage at the destination and shown as such, because a transfer
   that silently balances hides the loss in nobody's numbers.
   ========================================================================= */

interface Branch {
  id: string;
  name: string;
}

type Scope = 'open' | 'all';

export default function Transfers({
  transfers,
  products,
  branches,
  loading,
  canManage,
  onRefetch,
}: {
  transfers: StockTransfer[];
  products: StoreProduct[];
  branches: Branch[];
  loading: boolean;
  canManage: boolean;
  onRefetch: () => void;
}) {
  const [scope, setScope] = useState<Scope>('open');
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const rows = useMemo(
    () => (scope === 'open' ? transfers.filter((t) => t.state === 'draft' || t.state === 'dispatched') : transfers),
    [transfers, scope],
  );

  const inTransit = transfers.filter((t) => t.state === 'dispatched').length;

  return (
    <>
      <Toolbar>
        <Segmented
          label="Transfer filter"
          value={scope}
          onChange={setScope}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'all', label: 'All' },
          ]}
        />
        {inTransit > 0 ? <Chip tone="warn">{inTransit} in transit</Chip> : null}
        <span className="flex-1" />
        {canManage ? (
          <Button variant="cta" onClick={() => setCreating(true)}>
            New transfer
          </Button>
        ) : null}
      </Toolbar>

      <Panel>
        {loading ? (
          <Skeleton className="m-4 h-48" />
        ) : rows.length === 0 ? (
          <EmptyState
            title={scope === 'open' ? 'Nothing in transit' : 'No transfers yet'}
            body="Stock moving between branches shows here from the moment it is drafted until it is counted in at the other end."
            action={
              canManage ? (
                <Button variant="cta" onClick={() => setCreating(true)}>
                  New transfer
                </Button>
              ) : null
            }
          />
        ) : (
          <TableScroll className="max-h-[calc(100vh-230px)]">
            <Table>
              <THead>
                <TH>Reference</TH>
                <TH>From</TH>
                <TH>To</TH>
                <TH align="center">State</TH>
                <TH align="right">In transit</TH>
                <TH>Raised</TH>
                <TH>By</TH>
              </THead>
              <tbody>
                {rows.map((transfer) => (
                  <TR key={transfer.id} selected={openId === transfer.id} onClick={() => setOpenId(transfer.id)}>
                    <TD className="font-utility text-[11px]">{transfer.reference}</TD>
                    <TD className="text-[12px] text-foam-65">{transfer.fromBranchName}</TD>
                    <TD className="text-[12px] text-foam-65">{transfer.toBranchName}</TD>
                    <TD align="center">
                      <TransferStateChip state={transfer.state} />
                    </TD>
                    <TD numeric className={transfer.unitsInTransit > 0 ? 'text-flare' : 'text-foam-35'}>
                      {transfer.unitsInTransit || '—'}
                    </TD>
                    <TD className="whitespace-nowrap text-[12px] text-foam-65">{dateTime(transfer.createdAt)}</TD>
                    <TD className="text-[12px] text-foam-65">{transfer.createdBy}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        )}
      </Panel>

      {openId ? (
        <TransferDrawer
          transferId={openId}
          canManage={canManage}
          onClose={() => setOpenId(null)}
          onChanged={onRefetch}
        />
      ) : null}

      {creating ? (
        <NewTransfer
          products={products}
          branches={branches}
          onClose={() => setCreating(false)}
          onCreated={onRefetch}
        />
      ) : null}
    </>
  );
}

/* — Detail: dispatch, receive, cancel ——————————————————————————— */

function TransferDrawer({
  transferId,
  canManage,
  onClose,
  onChanged,
}: {
  transferId: string;
  canManage: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [received, setReceived] = useState<Record<string, number>>({});
  const [seeded, setSeeded] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ['store', 'transfer', transferId],
    queryFn: () => api<StockTransferDetail>(`/admin/store/transfers/${transferId}`),
  });

  // Default the receipt count to what was sent — the common case is that it all
  // arrived, and the operator only edits the lines that came up short.
  if (detail.data && seeded !== transferId) {
    setSeeded(transferId);
    setReceived(Object.fromEntries(detail.data.lines.map((l) => [l.id, l.quantity])));
  }

  const settle = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['store'] });
    onChanged();
    void detail.refetch();
  };

  const dispatch = useMutation({
    mutationFn: () =>
      api(`/admin/store/transfers/${transferId}/dispatch`, { method: 'POST', body: { overrideReason: null } }),
    onSuccess: () => {
      setError(null);
      settle();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'The dispatch did not go through.'),
  });

  const receive = useMutation({
    mutationFn: () =>
      api(`/admin/store/transfers/${transferId}/receive`, {
        method: 'POST',
        body: { lines: Object.entries(received).map(([lineId, quantity]) => ({ lineId, quantity })) },
      }),
    onSuccess: () => {
      setError(null);
      settle();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'The receipt did not go through.'),
  });

  const cancel = useMutation({
    mutationFn: () =>
      api(`/admin/store/transfers/${transferId}/cancel`, {
        method: 'POST',
        body: { reason: cancelReason.trim() },
      }),
    onSuccess: () => {
      setCancelOpen(false);
      setCancelReason('');
      setError(null);
      settle();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'The cancellation did not go through.'),
  });

  const transfer = detail.data?.transfer;
  const lines = detail.data?.lines ?? [];
  const dispatched = lines.reduce((sum, l) => sum + l.quantity, 0);
  const counted = lines.reduce((sum, l) => sum + (received[l.id] ?? l.quantity), 0);
  const shortBy = dispatched - counted;
  const pending = dispatch.isPending || receive.isPending;

  return (
    <>
      <Drawer
        open
        onClose={onClose}
        kicker={transfer ? `${transfer.fromBranchName} → ${transfer.toBranchName}` : 'Loading'}
        title={transfer?.reference ?? 'Transfer'}
        footer={
          canManage && transfer ? (
            <div className="flex items-center gap-2">
              {transfer.state === 'draft' ? (
                <>
                  <Button variant="danger" onClick={() => setCancelOpen(true)}>
                    Cancel draft
                  </Button>
                  <Button variant="cta" className="flex-1" disabled={pending} onClick={() => dispatch.mutate()}>
                    {dispatch.isPending ? 'Dispatching…' : `Dispatch ${dispatched} units`}
                  </Button>
                </>
              ) : transfer.state === 'dispatched' ? (
                <Button variant="cta" full disabled={pending} onClick={() => receive.mutate()}>
                  {receive.isPending ? 'Receiving…' : `Receive ${counted} of ${dispatched}`}
                </Button>
              ) : null}
            </div>
          ) : null
        }
      >
        {detail.isLoading || !transfer ? (
          <Skeleton className="m-3 h-48" />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
              <TransferStateChip state={transfer.state} />
              <span className="text-[12px] text-foam-65">Raised by {transfer.createdBy}</span>
            </div>

            <dl className="grid grid-cols-2 gap-px bg-line">
              <Fact label="Dispatched" value={transfer.dispatchedAt ? dateTime(transfer.dispatchedAt) : '—'} />
              <Fact label="By" value={transfer.dispatchedBy ?? '—'} />
              <Fact label="Received" value={transfer.receivedAt ? dateTime(transfer.receivedAt) : '—'} />
              <Fact label="By" value={transfer.receivedBy ?? '—'} />
            </dl>

            {transfer.note ? (
              <p className="border-b border-line px-3 py-2 text-[12px] text-foam-65">{transfer.note}</p>
            ) : null}

            {transfer.state === 'dispatched' ? (
              <p className="border-b border-line bg-wash-flare px-3 py-2 text-[12px] text-foam-80">
                These units have left {transfer.fromBranchName} and are on neither shelf. Count what
                actually arrived — the difference is written off as shrinkage at{' '}
                {transfer.toBranchName}, not quietly forgotten.
              </p>
            ) : null}

            <TableScroll>
              <Table>
                <THead>
                  <TH>Item</TH>
                  <TH align="right">Sent</TH>
                  {transfer.state === 'dispatched' ? <TH align="right">Arrived</TH> : null}
                  {transfer.state === 'received' ? <TH align="right">Received</TH> : null}
                  {transfer.state === 'received' ? <TH align="right">Short</TH> : null}
                </THead>
                <tbody>
                  {lines.map((line) => (
                    <TR key={line.id}>
                      <TD>
                        <div className="max-w-[22ch] truncate">{line.productName}</div>
                        <div className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
                          {line.sku}
                        </div>
                      </TD>
                      <TD numeric>{line.quantity}</TD>
                      {transfer.state === 'dispatched' ? (
                        <TD align="right">
                          <div className="flex justify-end">
                            <Stepper
                              value={received[line.id] ?? line.quantity}
                              min={0}
                              max={line.quantity}
                              label={line.productName}
                              onChange={(q) => setReceived({ ...received, [line.id]: q })}
                            />
                          </div>
                        </TD>
                      ) : null}
                      {transfer.state === 'received' ? <TD numeric>{line.quantityReceived}</TD> : null}
                      {transfer.state === 'received' ? (
                        <TD numeric className={line.shortfall > 0 ? 'text-chum' : 'text-foam-35'}>
                          {line.shortfall > 0 ? line.shortfall : '—'}
                        </TD>
                      ) : null}
                    </TR>
                  ))}
                </tbody>
              </Table>
            </TableScroll>

            {transfer.state === 'dispatched' && shortBy > 0 ? (
              <p className="border-t border-line bg-wash-chum px-3 py-2 text-[12px] text-foam-80">
                {shortBy} unit{shortBy === 1 ? '' : 's'} short. Receiving now books{' '}
                {shortBy === 1 ? 'it' : 'them'} as damage at {transfer.toBranchName} and{' '}
                {shortBy === 1 ? 'it' : 'they'} will show in shrinkage.
              </p>
            ) : null}

            {error ? (
              <p role="alert" className="border-t border-line bg-wash-chum px-3 py-2 text-[12px] text-foam-80">
                {error}
              </p>
            ) : null}
          </>
        )}
      </Drawer>

      <ConfirmDialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        onConfirm={() => cancel.mutate()}
        title={`Cancel ${transfer?.reference ?? 'this transfer'}?`}
        consequence="Nothing has left the shelf yet, so no stock moves. The draft is closed for good and cannot be dispatched afterwards — raise a new transfer if it is needed again."
        confirmLabel="Cancel the draft"
        reasonLabel="Reason"
        reason={cancelReason}
        onReasonChange={setCancelReason}
        pending={cancel.isPending}
      />
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-panel px-3 py-2">
      <dt className="font-utility text-[9px] uppercase tracking-[0.14em] text-foam-45">{label}</dt>
      <dd className="mt-0.5 text-[12px]">{value}</dd>
    </div>
  );
}

/* — Draft a transfer ————————————————————————————————————————————— */

function NewTransfer({
  products,
  branches,
  onClose,
  onCreated,
}: {
  products: StoreProduct[];
  branches: Branch[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const queryClient = useQueryClient();
  const [fromBranchId, setFromBranchId] = useState(branches[0]?.id ?? '');
  const [toBranchId, setToBranchId] = useState(branches[1]?.id ?? '');
  const [note, setNote] = useState('');
  const [search, setSearch] = useState('');
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);

  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return products.filter((p) => p.active).slice(0, 20);
    return products
      .filter((p) => p.active && (p.displayName.toLowerCase().includes(needle) || p.sku.toLowerCase().includes(needle)))
      .slice(0, 20);
  }, [products, search]);

  const picked = Object.entries(quantities).filter(([, q]) => q > 0);

  const create = useMutation({
    mutationFn: () =>
      api('/admin/store/transfers', {
        method: 'POST',
        body: {
          fromBranchId,
          toBranchId,
          note: note.trim() || null,
          lines: picked.map(([productId, quantity]) => ({ productId, quantity })),
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['store'] });
      onCreated();
      onClose();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'The transfer did not save.'),
  });

  const sameBranch = fromBranchId === toBranchId;
  const ready = !sameBranch && fromBranchId !== '' && toBranchId !== '' && picked.length > 0;

  return (
    <Drawer
      open
      onClose={onClose}
      kicker="Transfers"
      title="New transfer"
      footer={
        <Button variant="cta" full disabled={!ready || create.isPending} onClick={() => create.mutate()}>
          {create.isPending
            ? 'Saving…'
            : picked.length === 0
              ? 'Add at least one item'
              : `Save draft · ${picked.reduce((sum, [, q]) => sum + q, 0)} units`}
        </Button>
      }
    >
      <div className="grid grid-cols-2 gap-px bg-line">
        <BranchSelect label="From" value={fromBranchId} branches={branches} onChange={setFromBranchId} />
        <BranchSelect label="To" value={toBranchId} branches={branches} onChange={setToBranchId} />
      </div>

      {sameBranch ? (
        <p className="border-b border-line bg-wash-flare px-3 py-2 text-[12px] text-foam-80">
          A transfer needs two different branches.
        </p>
      ) : null}

      <div className="border-b border-line p-3">
        <input
          className="sf-field !min-h-9 !text-[13px]"
          placeholder="Note — why this stock is moving (optional)"
          aria-label="Transfer note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      <div className="border-b border-line p-3">
        <Label>Items</Label>
        <input
          className="sf-field mt-1.5 !min-h-9 !text-[13px]"
          placeholder="Search the catalogue"
          aria-label="Search products to transfer"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <TableScroll className="max-h-[380px]">
        <Table>
          <THead>
            <TH>Item</TH>
            <TH align="right">On hand</TH>
            <TH align="right">Send</TH>
          </THead>
          <tbody>
            {matches.map((product) => (
              <TR key={product.id}>
                <TD>
                  <div className="max-w-[20ch] truncate">{product.displayName}</div>
                  <div className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
                    {product.sku}
                  </div>
                </TD>
                <TD numeric className="text-foam-65">
                  {product.onHand}
                </TD>
                <TD align="right">
                  <div className="flex justify-end">
                    <Stepper
                      value={quantities[product.id] ?? 0}
                      min={0}
                      label={product.displayName}
                      onChange={(q) => setQuantities({ ...quantities, [product.id]: q })}
                    />
                  </div>
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      </TableScroll>

      {error ? (
        <p role="alert" className="border-t border-line bg-wash-chum px-3 py-2 text-[12px] text-foam-80">
          {error}
        </p>
      ) : null}
    </Drawer>
  );
}

function BranchSelect({
  label,
  value,
  branches,
  onChange,
}: {
  label: string;
  value: string;
  branches: Branch[];
  onChange: (value: string) => void;
}) {
  const id = `transfer_${label.toLowerCase()}`;
  return (
    <div className="bg-panel px-3 py-2">
      <label htmlFor={id} className="font-utility text-[9px] uppercase tracking-[0.14em] text-foam-45">
        {label}
      </label>
      <select
        id={id}
        className="mt-1 min-h-9 w-full border border-line bg-panel px-2 text-[13px] text-foam"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {branches.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
    </div>
  );
}
