import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TenantDetail, TenantMeter, TenantStatus, TenantSummary } from '@shark/contracts';
import { ApiError, api } from '../../lib/api';
import {
  Button,
  Chip,
  EmptyState,
  ErrorState,
  Field,
  Label,
  RowOpen,
  SelectField,
  Skeleton,
  Table,
  TableScroll,
  TD,
  TH,
  THead,
  TR,
  Toolbar,
  type Tone,
} from '../../ui/console';
import { Modal } from '../../ui/overlay';

/* ============================================================================
   The customer list.

   A table, because that is what this is: one row per gym, sorted by the thing
   an operator is actually looking for, which is trouble. A gym over its quota
   or suspended is the reason to open this screen; a healthy one is a row you
   skim past.
   ========================================================================= */

const STATUS_TONE: Record<TenantStatus, Tone> = {
  active: 'good',
  trial: 'accent',
  suspended: 'bad',
  archived: 'neutral',
};

const METER_TONE: Record<TenantMeter['health'], Tone> = {
  ok: 'good',
  approaching: 'warn',
  exceeded: 'bad',
  unmetered: 'neutral',
};

export default function Tenants({ canAdminister }: { canAdminister: boolean }) {
  const [openId, setOpenId] = useState<string | null>(null);

  const tenants = useQuery({
    queryKey: ['platform', 'tenants'],
    queryFn: () => api<{ items: TenantSummary[] }>('/platform/tenants'),
  });

  if (tenants.isLoading) return <Skeleton className="h-96" />;
  if (tenants.error || !tenants.data) {
    return (
      <ErrorState
        title="The customer list could not be read"
        body={tenants.error instanceof ApiError ? tenants.error.message : 'The server did not answer.'}
        onRetry={() => void tenants.refetch()}
      />
    );
  }

  const items = tenants.data.items;
  const needingAttention = items.filter((t) => t.metersNeedingAttention.length > 0 || t.status === 'suspended').length;

  return (
    <>
      <Toolbar>
        <Label>Customers</Label>
        <span className="font-utility text-[11px] uppercase tracking-[0.12em] text-foam-45">{items.length} gyms</span>
        {needingAttention > 0 ? <Chip tone="warn">{needingAttention} needing attention</Chip> : null}
      </Toolbar>

      {items.length === 0 ? (
        <EmptyState title="No customers yet" body="Gyms appear here as they are onboarded." />
      ) : (
        <TableScroll>
          <Table label="Customers">
            <THead>
              <TH>Gym</TH>
              <TH>Status</TH>
              <TH>Plan</TH>
              <TH numeric>Members</TH>
              <TH numeric>Branches</TH>
              <TH numeric>Check-ins 30d</TH>
              <TH>Usage</TH>
            </THead>
            <tbody>
              {items.map((tenant) => (
                <TR key={tenant.id} onClick={() => setOpenId(tenant.id)}>
                  <TD>
                    <RowOpen onClick={() => setOpenId(tenant.id)} className="block truncate text-foam">
                      {tenant.displayName}
                    </RowOpen>
                    <span className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">{tenant.slug}</span>
                  </TD>
                  <TD>
                    <Chip tone={STATUS_TONE[tenant.status]}>{tenant.status}</Chip>
                  </TD>
                  <TD className="capitalize">{tenant.plan}</TD>
                  <TD numeric>{tenant.counts.members}</TD>
                  <TD numeric>
                    {tenant.counts.activeBranches}
                    {tenant.counts.branches !== tenant.counts.activeBranches ? (
                      <span className="text-foam-35"> / {tenant.counts.branches}</span>
                    ) : null}
                  </TD>
                  <TD numeric>{tenant.counts.checkIns30d}</TD>
                  <TD>
                    {tenant.metersNeedingAttention.length === 0 ? (
                      <span className="text-foam-35">—</span>
                    ) : (
                      <span className="flex flex-wrap gap-1.5">
                        {tenant.metersNeedingAttention.map((m) => (
                          <Chip key={m.meter} tone={METER_TONE[m.health]}>
                            {m.meter.replace(/_/g, ' ')} {m.percent}%
                          </Chip>
                        ))}
                      </span>
                    )}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </TableScroll>
      )}

      {openId ? <TenantDialog tenantId={openId} canAdminister={canAdminister} onClose={() => setOpenId(null)} /> : null}
    </>
  );
}

/* ——— One customer ————————————————————————————————————— */

function TenantDialog({ tenantId, canAdminister, onClose }: { tenantId: string; canAdminister: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<TenantStatus | ''>('');
  const [reason, setReason] = useState('');
  const [approvedBy, setApprovedBy] = useState('');
  const [impersonating, setImpersonating] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ['platform', 'tenant', tenantId],
    queryFn: () => api<{ tenant: TenantDetail }>(`/platform/tenants/${tenantId}`),
  });

  const change = useMutation({
    mutationFn: () =>
      api(`/platform/tenants/${tenantId}/status`, {
        method: 'POST',
        body: { status, reason: reason.trim(), ...(approvedBy.trim() ? { approvedBy: approvedBy.trim() } : {}) },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['platform'] });
      setStatus('');
      setReason('');
    },
  });

  const tenant = detail.data?.tenant;

  return (
    <Modal
      open
      onClose={onClose}
      title={tenant?.displayName ?? 'Customer'}
      kicker={tenant ? tenant.legalName : undefined}
      width="w-[min(760px,100%)]"
      footer={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      {detail.isLoading || !tenant ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="flex flex-col">
          <div className="flex flex-wrap items-start gap-x-5 gap-y-2 border-b border-line px-4 py-3">
            <div className="min-w-[200px] flex-1">
              <Chip tone={STATUS_TONE[tenant.status]}>{tenant.status}</Chip>
              <p className="mt-1.5 max-w-[62ch] text-[12px] leading-relaxed text-foam-65">{tenant.statusMeaning}</p>
            </div>
            <dl className="flex flex-wrap gap-x-5 gap-y-1">
              <Stat label="Members" value={tenant.counts.members} />
              <Stat label="Branches" value={tenant.counts.branches} />
              <Stat label="Staff" value={tenant.counts.staff} />
              <Stat label="Check-ins 30d" value={tenant.counts.checkIns30d} />
            </dl>
          </div>

          <Section title="Usage this month">
            {tenant.meters.length === 0 ? (
              <p className="text-[12px] text-foam-45">No meters recorded for this period.</p>
            ) : (
              <ul className="divide-y divide-line border-y border-line">
                {tenant.meters.map((m) => (
                  <li key={m.meter} className="flex items-center gap-3 py-2">
                    <span className="min-w-0 flex-1 truncate text-[13px] capitalize">{m.meter.replace(/_/g, ' ')}</span>
                    <span className="font-utility text-[11px] tabular-nums text-foam-45">
                      {m.used.toLocaleString('en-IN')}
                      {m.limit > 0 ? ` / ${m.limit.toLocaleString('en-IN')}` : ''}
                    </span>
                    <Chip tone={METER_TONE[m.health]}>
                      {m.health === 'unmetered' ? 'not sold' : m.percent !== null ? `${m.percent}%` : m.health}
                    </Chip>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Support access">
            <p className="max-w-[70ch] text-[11px] leading-relaxed text-foam-45">
              Entering an account records the reason in this gym’s own audit log under your name, and expires after an
              hour. You cannot reach platform tools while inside.
            </p>
            {tenant.owners.length === 0 ? (
              <p className="text-[12px] text-foam-45">No owner account to enter.</p>
            ) : (
              <ul className="divide-y divide-line border-y border-line">
                {tenant.owners.map((owner) => (
                  <li key={owner.id} className="flex flex-wrap items-center gap-3 py-2">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px]">{owner.name}</span>
                      <span className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
                        {owner.role.replace(/_/g, ' ')} · {owner.accountState}
                      </span>
                    </span>
                    <Button
                      variant="outline"
                      disabled={owner.accountState !== 'active' || tenant.status === 'archived'}
                      onClick={() => setImpersonating(owner.id)}
                    >
                      Enter account
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {tenant.legalHolds > 0 ? (
            <p className="border-b border-line bg-wash-chum px-4 py-2.5 text-[12px] leading-relaxed text-foam-80">
              {tenant.legalHolds} {tenant.legalHolds === 1 ? 'account is' : 'accounts are'} under legal hold. This gym
              cannot be offboarded until whoever placed the hold lifts it.
            </p>
          ) : null}

          {canAdminister ? (
          <Section title="Change status">
            <p className="max-w-[70ch] text-[11px] leading-relaxed text-foam-45">{tenant.suspensionNotice}</p>
            <div className="flex flex-wrap items-end gap-2">
              <SelectField
                label="Move to"
                className="!w-auto"
                value={status}
                onChange={(e) => setStatus(e.target.value as TenantStatus)}
                options={[
                  { value: '', label: 'Leave as it is' },
                  ...tenant.nextStatuses.map((s) => ({ value: s, label: s })),
                ]}
              />
              {status ? (
                <>
                  <Field
                    label="Reason"
                    className="min-w-[220px] flex-1"
                    hint="Recorded in this gym’s audit log. They can read it."
                    placeholder="Three failed platform payments, contract clause 7"
                    value={reason}
                    autoFocus
                    onChange={(e) => setReason(e.target.value)}
                  />
                  <Field
                    label="Approved by"
                    className="!w-auto"
                    hint="Optional"
                    value={approvedBy}
                    onChange={(e) => setApprovedBy(e.target.value)}
                  />
                  <Button
                    variant={status === 'archived' || status === 'suspended' ? 'danger' : 'cta'}
                    disabled={reason.trim().length < 8 || change.isPending}
                    pending={change.isPending}
                    pendingLabel="Applying…"
                    onClick={() => change.mutate()}
                  >
                    Apply
                  </Button>
                </>
              ) : null}
            </div>
            {change.isError ? (
              <p role="alert" className="border border-chum bg-wash-chum px-3 py-2 text-[12px] leading-relaxed text-foam-80">
                {change.error instanceof ApiError ? change.error.message : 'That change could not be applied.'}
              </p>
            ) : null}
          </Section>
          ) : null}

          {tenant.recentActions.length > 0 ? (
            <Section title="What we have done to this gym">
              <ul className="divide-y divide-line border-y border-line">
                {tenant.recentActions.map((entry, i) => (
                  <li key={`${entry.at}-${i}`} className="py-2">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
                        {new Date(entry.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
                      </span>
                      <span className="text-[12px]">{entry.action.replace(/[._]/g, ' ')}</span>
                      <span className="text-[11px] text-foam-45">{entry.actorName}</span>
                    </div>
                    {entry.reason ? <p className="mt-0.5 text-[11px] leading-relaxed text-foam-45">{entry.reason}</p> : null}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
        </div>
      )}

      {impersonating ? (
        <ImpersonateDialog userId={impersonating} tenantName={tenant?.displayName ?? ''} onClose={() => setImpersonating(null)} />
      ) : null}
    </Modal>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="font-utility text-[9px] uppercase tracking-[0.14em] text-foam-35">{label}</dt>
      <dd className="mt-0.5 font-display text-[16px] leading-none tabular-nums">{value.toLocaleString('en-IN')}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="border-b border-line">
      <h3 className="border-b border-line bg-hull px-4 py-2 font-utility text-[10px] font-semibold uppercase tracking-[0.18em] text-foam-45">
        {title}
      </h3>
      <div className="flex flex-col gap-3 px-4 py-3">{children}</div>
    </section>
  );
}

/**
 * Starting a support session.
 *
 * A separate confirm rather than a button that just does it, because this
 * swaps the operator's own session for a borrowed one: they will be signed
 * into somebody else's gym and will have to sign back in to return. Saying so
 * beforehand costs a sentence and prevents a surprise.
 */
function ImpersonateDialog({
  userId,
  tenantName,
  onClose,
}: {
  userId: string;
  tenantName: string;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');

  const start = useMutation({
    mutationFn: () => api('/platform/impersonate', { method: 'POST', body: { userId, reason: reason.trim() } }),
    // A full reload rather than a router push: every cached query belongs to
    // the operator's own session and none of it is theirs any more.
    onSuccess: () => window.location.assign('/admin/'),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Enter this account"
      kicker={tenantName}
      width="w-[min(520px,100%)]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="cta"
            disabled={reason.trim().length < 8 || start.isPending}
            pending={start.isPending}
            pendingLabel="Entering…"
            onClick={() => start.mutate()}
          >
            Enter account
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 p-4">
        <p className="text-[13px] leading-relaxed text-foam-80">
          You will be signed in as this person for one hour. Your own session ends — coming back is a fresh sign-in.
        </p>
        <p className="text-[12px] leading-relaxed text-foam-45">
          Everything you do is recorded in {tenantName}’s audit log under your name, with the reason below. They can
          read it.
        </p>
        <Field
          label="Why you need access"
          hint="At least a sentence. A ticket number helps whoever reads this later."
          placeholder="Investigating the duplicate invoice on ticket SUP-1042"
          value={reason}
          autoFocus
          onChange={(e) => setReason(e.target.value)}
        />
        {start.isError ? (
          <p role="alert" className="border border-chum bg-wash-chum px-3 py-2 text-[12px] text-foam-80">
            {start.error instanceof ApiError ? start.error.message : 'That account could not be entered.'}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

export { STATUS_TONE, METER_TONE };
