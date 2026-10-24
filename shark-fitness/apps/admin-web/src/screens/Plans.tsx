import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api';
import { useAdmin, usePermission } from '../lib/store';
import { Page } from '../ui/shell';
import { Button, Checkbox, Chip, Display, EmptyState, ErrorState, Field, Panel, PermissionState, SelectField, Skeleton, type Tone } from '../ui/console';
import { ConfirmDialog, Modal } from '../ui/overlay';

interface ProductRow {
  id: string;
  kind: string;
  name: string;
  description: string;
  version: number;
  priceMinor: number;
  priceLabel: string;
  cadence: string;
  durationDays: number | null;
  credits: number | null;
  access: { allBranches: boolean; branchIds: string[] };
  freeze: { allowed: boolean; maxDaysPerTerm: number };
  cancellation: { noticeDays: number; refundable: boolean; description: string };
  branchIds: string[];
  status: 'draft' | 'active' | 'retired';
}

const KINDS = ['membership', 'class_pack', 'pt_credits', 'trial', 'day_pass', 'corporate', 'digital', 'addon', 'retail_bundle'] as const;
const CADENCES = ['one_time', 'monthly', 'quarterly', 'half_yearly', 'annual'] as const;
const STATUS_TONE: Record<string, Tone> = { draft: 'neutral', active: 'good', retired: 'bad' };

export default function PlansScreen() {
  const canManage = usePermission('product.manage');
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [retireTarget, setRetireTarget] = useState<ProductRow | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['products'],
    queryFn: () => api<{ items: ProductRow[] }>('/admin/billing/products'),
    enabled: canManage,
  });

  const invalidate = (): void => void queryClient.invalidateQueries({ queryKey: ['products'] });

  const publish = useMutation({
    mutationFn: (p: ProductRow) => api(`/admin/billing/products/${p.id}`, { method: 'PATCH', body: { status: 'active' } }),
    onSuccess: invalidate,
  });

  const duplicate = useMutation({
    mutationFn: (p: ProductRow) => api(`/admin/billing/products/${p.id}/duplicate`, { method: 'POST' }),
    onSuccess: invalidate,
  });

  if (!canManage) {
    return (
      <Page title="Plans">
        <PermissionState what="The membership product catalogue" />
      </Page>
    );
  }

  if (isLoading) {
    return (
      <Page title="Plans" kicker="Loading">
        <div className="grid grid-cols-1 gap-3 p-4 md:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      </Page>
    );
  }

  if (error || !data) {
    return (
      <Page title="Plans">
        <ErrorState title="Could not load the catalogue" body="The API did not answer. Nothing has changed." onRetry={() => void refetch()} />
      </Page>
    );
  }

  return (
    <Page
      title="Plans"
      kicker={`${data.items.length} products`}
      actions={
        <Button variant="cta" onClick={() => setShowCreate(true)}>
          New product
        </Button>
      }
    >
      {data.items.length === 0 ? (
        <EmptyState title="No products yet" body="Build your first membership, class pack, or pass." action={<Button variant="cta" onClick={() => setShowCreate(true)}>New product</Button>} />
      ) : (
        <div className="grid grid-cols-1 gap-px bg-line p-px md:grid-cols-2 xl:grid-cols-3">
          {data.items.map((p) => (
            <Panel key={p.id} title={p.kind.replace(/_/g, ' ')} className="bg-hull" action={<Chip tone={STATUS_TONE[p.status]}>{p.status}</Chip>}>
              <div className="flex flex-col gap-2 p-3.5">
                <Display size="sm" as="h3">
                  {p.name}
                </Display>
                <p className="text-[12px] leading-relaxed text-foam-65">{p.description}</p>
                <div className="flex items-baseline gap-1.5">
                  <span className="font-display text-[20px]">{p.priceLabel}</span>
                  <span className="text-[11px] text-foam-45">/ {p.cadence.replace(/_/g, ' ')}</span>
                </div>
                <div className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
                  {p.access.allBranches ? 'All branches' : `${p.access.branchIds.length} branch${p.access.branchIds.length === 1 ? '' : 'es'}`}
                  {p.freeze.allowed ? ` · freeze up to ${p.freeze.maxDaysPerTerm}d` : ' · no freeze'}
                  {p.cancellation.refundable ? ' · refundable' : ''}
                </div>
                <div className="mt-1 flex flex-wrap gap-2">
                  {p.status === 'draft' ? (
                    <Button variant="cta" onClick={() => publish.mutate(p)} disabled={publish.isPending}>
                      Publish
                    </Button>
                  ) : null}
                  <Button variant="outline" onClick={() => duplicate.mutate(p)} disabled={duplicate.isPending}>
                    Duplicate
                  </Button>
                  {p.status !== 'retired' ? (
                    <Button variant="danger" onClick={() => setRetireTarget(p)}>
                      Retire
                    </Button>
                  ) : null}
                </div>
              </div>
            </Panel>
          ))}
        </div>
      )}

      {showCreate ? <CreateProductSheet onClose={() => setShowCreate(false)} onDone={invalidate} /> : null}
      {retireTarget ? <RetireSheet product={retireTarget} onClose={() => setRetireTarget(null)} onDone={invalidate} /> : null}
    </Page>
  );
}

function RetireSheet({ product, onClose, onDone }: { product: ProductRow; onClose: () => void; onDone: () => void }) {
  const [impact, setImpact] = useState<number | null>(null);
  const retire = useMutation({
    mutationFn: () => api<{ activeMembershipCount: number }>(`/admin/billing/products/${product.id}/retire`, { method: 'POST' }),
    onSuccess: (res) => {
      setImpact(res.activeMembershipCount);
    },
  });

  if (retire.isSuccess) {
    return (
      <Modal
        open
        onClose={() => { onDone(); onClose(); }}
        title={`${product.name} retired`}
        width="w-[min(440px,100%)]"
        footer={
          <Button variant="cta" onClick={() => { onDone(); onClose(); }}>
            Done
          </Button>
        }
      >
        <p className="p-4 text-[12px] leading-relaxed text-foam-65">
          {impact && impact > 0
            ? `${impact} membership${impact === 1 ? '' : 's'} already on this product keep their purchased terms — retiring only stops new purchases.`
            : 'No memberships are currently on this product.'}
        </p>
      </Modal>
    );
  }

  return (
    <ConfirmDialog
      open
      onClose={onClose}
      onConfirm={() => retire.mutate()}
      title={`Retire ${product.name}?`}
      consequence="No one will be able to purchase this product afterwards. Existing members on it keep their terms exactly as purchased."
      confirmLabel="Retire"
      pending={retire.isPending}
    />
  );
}

function CreateProductSheet({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const branches = useAdmin((s) => s.branches);
  const [kind, setKind] = useState<string>('membership');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [priceMajor, setPriceMajor] = useState('');
  const [cadence, setCadence] = useState<string>('monthly');
  const [durationDays, setDurationDays] = useState('30');
  const [allBranches, setAllBranches] = useState(true);
  const [branchIds, setBranchIds] = useState<string[]>([]);
  const [freezeAllowed, setFreezeAllowed] = useState(true);
  const [maxFreezeDays, setMaxFreezeDays] = useState('30');
  const [noticeDays, setNoticeDays] = useState('7');
  const [refundable, setRefundable] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api<{ id: string }>('/admin/billing/products', {
        method: 'POST',
        body: {
          kind,
          name: name.trim(),
          description: description.trim(),
          priceMinor: Math.round(Number(priceMajor || 0) * 100),
          cadence,
          durationDays: durationDays.trim() ? Number(durationDays) : null,
          credits: null,
          creditsExpireDays: null,
          access: {
            allBranches,
            branchIds: allBranches ? [] : branchIds,
            windowStartMin: null,
            windowEndMin: null,
            visitsPerWeek: null,
            guestPassesPerMonth: 0,
            classPriorityTier: 1,
            bookingWindowHours: 24,
          },
          freeze: { allowed: freezeAllowed, maxDaysPerTerm: freezeAllowed ? Number(maxFreezeDays || 0) : 0, minDaysPerFreeze: 1, extendsExpiry: true, feeMinor: 0 },
          cancellation: { noticeDays: Number(noticeDays || 0), commitmentMonths: 0, earlyExitFeeMinor: 0, refundable, description: refundable ? 'Refundable per policy.' : 'Non-refundable once purchased.' },
        },
      }),
    onSuccess: () => {
      onDone();
      onClose();
    },
  });

  const apiErrorMessage = create.error instanceof ApiError ? create.error.message : create.isError ? 'That did not work.' : null;

  const submit = (): void => {
    setFieldError(null);
    if (!name.trim()) return setFieldError('Name is required.');
    if (!priceMajor.trim() || Number(priceMajor) < 0) return setFieldError('Set a price of 0 or more.');
    if (!allBranches && branchIds.length === 0) return setFieldError('Choose at least one branch, or allow all branches.');
    create.mutate();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="New product"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="cta" size="md" pending={create.isPending} pendingLabel="Creating…" onClick={submit}>
            Create as draft
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5 p-4">
          <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Elite Annual" autoFocus />
          <Field label="Description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What a member gets" />

          <div className="grid grid-cols-2 gap-3">
            <SelectField
              label="Type"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              options={KINDS.map((k) => ({ value: k, label: k.replace(/_/g, ' ') }))}
            />
            <SelectField
              label="Billing cadence"
              value={cadence}
              onChange={(e) => setCadence(e.target.value)}
              options={CADENCES.map((cd) => ({ value: cd, label: cd.replace(/_/g, ' ') }))}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Price (₹)" type="number" min={0} value={priceMajor} onChange={(e) => setPriceMajor(e.target.value)} placeholder="2999" />
            <Field label="Duration (days)" type="number" min={0} value={durationDays} onChange={(e) => setDurationDays(e.target.value)} hint="Blank = no fixed term" />
          </div>

          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2.5 text-[13px]">
              <input type="checkbox" checked={allBranches} onChange={(e) => setAllBranches(e.target.checked)} className="h-4 w-4 accent-[var(--sf-sonar)]" />
              Available at every branch
            </label>
            {!allBranches ? (
              <div className="flex flex-wrap gap-2 pl-6">
                {branches.map((b) => (
                  <label key={b.id} className="flex items-center gap-1.5 text-[12px]">
                    <input
                      type="checkbox"
                      checked={branchIds.includes(b.id)}
                      onChange={(e) => setBranchIds((prev) => (e.target.checked ? [...prev, b.id] : prev.filter((id) => id !== b.id)))}
                      className="h-3.5 w-3.5 accent-[var(--sf-sonar)]"
                    />
                    {b.name}
                  </label>
                ))}
              </div>
            ) : null}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-2">
              <Checkbox checked={freezeAllowed} onChange={(e) => setFreezeAllowed(e.target.checked)} label="Allow freezing" />
              {freezeAllowed ? <Field label="Max freeze days / term" type="number" min={0} value={maxFreezeDays} onChange={(e) => setMaxFreezeDays(e.target.value)} /> : null}
            </div>
            <div className="flex flex-col gap-2">
              <Field label="Cancellation notice (days)" type="number" min={0} value={noticeDays} onChange={(e) => setNoticeDays(e.target.value)} />
              <Checkbox checked={refundable} onChange={(e) => setRefundable(e.target.checked)} label="Refundable" />
            </div>
          </div>

          {fieldError ? (
            <Panel tone="bad">
              <p className="px-3 py-2.5 text-[12px] leading-relaxed">{fieldError}</p>
            </Panel>
          ) : null}
          {apiErrorMessage ? (
            <Panel tone="bad">
              <p className="px-3 py-2.5 text-[12px] leading-relaxed">{apiErrorMessage}</p>
            </Panel>
          ) : null}
      </div>
    </Modal>
  );
}
