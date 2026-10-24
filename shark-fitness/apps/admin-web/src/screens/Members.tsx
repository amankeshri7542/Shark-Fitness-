import { useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAdmin, usePermission } from '../lib/store';
import { Page } from '../ui/shell';
import { MembersBulkActions } from './members/BulkActions';
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
  Seam,
  Segmented,
  Skeleton,
  Toolbar,
  cx,
  type Tone,
  Table,
  TableScroll,
} from '../ui/console';

interface MemberRow {
  id: string;
  memberNo: string;
  name: string;
  initials: string;
  email: string | null;
  phone: string | null;
  lifecycle: string;
  branchName: string;
  trainerName: string | null;
  joinedOn: string;
  lastVisitLabel: string;
  daysSinceVisit: number | null;
  membershipState: string | null;
  productName: string | null;
  endsOn: string | null;
  autoRenew: boolean | null;
  balanceMinor: number | null;
  balanceLabel: string | null;
  riskScore: number | null;
  riskBand: 'high' | 'watch' | 'low' | null;
  riskReasons: string[];
  tags: string[];
}

interface MembersPayload {
  total: number;
  offset: number;
  limit: number;
  scopeNote: string;
  columns: { balanceVisible: boolean };
  items: MemberRow[];
}

const LIFECYCLES = ['all', 'engaged', 'active', 'trial', 'frozen', 'grace', 'expired', 'former'] as const;

const STATE_TONE: Record<string, Tone> = {
  active: 'good',
  trial: 'accent',
  frozen: 'neutral',
  grace: 'warn',
  expired: 'bad',
  suspended: 'bad',
  cancel_scheduled: 'warn',
};

export default function MembersScreen() {
  const canView = usePermission('member.view');
  const branchId = useAdmin((s) => s.activeBranchId);
  const filters = useSearch({ from: '/console/members' });
  const navigate = useNavigate({ from: '/members' });
  const search = filters.q ?? '';
  const lifecycle = filters.lifecycle ?? 'all';
  const risk = filters.risk ?? 'any';
  const offset = filters.offset ?? 0;
  const tag = filters.tag ?? null;
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const setFilters = (next: Partial<typeof filters>): void => {
    void navigate({
      search: (current) => ({ ...current, offset: 0, ...next }),
      replace: true,
    });
  };

  const params = new URLSearchParams();
  params.set('offset', String(offset));
  if (search.trim()) params.set('q', search.trim());
  if (lifecycle !== 'all') params.set('lifecycle', lifecycle);
  if (risk !== 'any') params.set('risk', risk);
  if (filters.joined) params.set('joined', filters.joined);
  if (filters.expiring) params.set('expiring', String(filters.expiring));
  if (tag) params.set('tag', tag);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['members', branchId, search, lifecycle, risk, filters.joined, filters.expiring, tag, offset],
    queryFn: () => api<MembersPayload>(`/admin/members?${params}`, { branchId }),
    placeholderData: keepPreviousData,
    enabled: canView,
  });

  if (!canView) {
    return (
      <Page title="Members">
        <PermissionState what="Member records" />
      </Page>
    );
  }

  if (isLoading) return <MembersSkeleton />;

  if (error || !data) {
    return (
      <Page title="Members">
        <ErrorState
          title="Could not load the directory"
          body="The API did not answer. Nothing has changed."
          onRetry={() => void refetch()}
        />
      </Page>
    );
  }

  // Act only on rows that are on screen. A selection made before the filters
  // or the page changed must not quietly carry members the operator can no
  // longer see.
  const selectedRows = data.items.filter((m) => selected.has(m.id));
  const allSelected = data.items.length > 0 && selectedRows.length === data.items.length;
  const toggleAll = (): void => setSelected(allSelected ? new Set() : new Set(data.items.map((m) => m.id)));
  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const atRisk = data.items.filter((m) => m.riskBand === 'high').length;
  const owing = data.items.filter((m) => (m.balanceMinor ?? 0) > 0).length;

  return (
    <Page
      title="Members"
      kicker={data.scopeNote}
      actions={
        <span className="font-utility text-[10px] uppercase tracking-[0.12em] text-foam-35">
          {data.total} total{isFetching ? ' · updating' : ''}
        </span>
      }
    >
      <Seam className="border-b border-line">
        <div className="min-w-[150px] flex-1 px-3.5 py-3">
          <Label>Showing</Label>
          <div className="mt-1.5">
            <Metric value={data.items.length} size="md" />
          </div>
        </div>
        <div className="min-w-[150px] flex-1 px-3.5 py-3">
            <Label>High risk on this page</Label>
          <div className="mt-1.5">
            <Metric value={atRisk} size="md" tone={atRisk > 0 ? 'warn' : 'default'} />
          </div>
        </div>
        {data.columns.balanceVisible ? (
          <div className="min-w-[150px] flex-1 px-3.5 py-3">
            <Label>With a balance on this page</Label>
            <div className="mt-1.5">
              <Metric value={owing} size="md" tone={owing > 0 ? 'bad' : 'default'} />
            </div>
          </div>
        ) : null}
      </Seam>

      <Toolbar>
        <Field
          label="Search"
          placeholder="Name, member number, email or phone"
          value={search}
          onChange={(e) => setFilters({ q: e.target.value || undefined })}
          className="min-w-[260px]"
        />

        {/* `Segmented`, not a hand-rolled row of bordered buttons. This screen
            carried the console's only remaining copy of that shape, and it ate
            seven tab stops where the shared control takes one and moves
            between options with the arrow keys — plus it clipped its last two
            filters off the side of a phone instead of scrolling. */}
        <div className="flex min-w-0 flex-col gap-1">
          <Label>Lifecycle</Label>
          <Segmented
            label="Lifecycle"
            size="md"
            value={lifecycle}
            onChange={(value) => setFilters({ lifecycle: value })}
            options={LIFECYCLES.map((value) => ({
              value,
              label: value === 'engaged' ? 'active + trial' : value,
            }))}
          />
        </div>

        <div className="flex min-w-0 flex-col gap-1">
          <Label>Risk</Label>
          <Segmented
            label="Risk"
            size="md"
            value={risk}
            onChange={(value) => setFilters({ risk: value })}
            options={[
              { value: 'any', label: 'any' },
              { value: 'watch', label: 'watch' },
              { value: 'high', label: 'high' },
            ]}
          />
        </div>

        {filters.joined ? <Chip tone="accent">Joined this month</Chip> : null}
        {filters.expiring ? <Chip tone="warn">Expiring in {filters.expiring} days</Chip> : null}
        {filters.joined || filters.expiring ? (
          <Button variant="outline" onClick={() => setFilters({ joined: undefined, expiring: undefined })}>
            Clear drill-down
          </Button>
        ) : null}

        {tag ? (
          <div className="flex flex-col gap-1">
            <Label>Tag</Label>
            <button
              type="button"
              onClick={() => setFilters({ tag: undefined })}
              aria-label={`Clear tag filter ${tag}`}
              className="min-h-9 border border-sonar px-2.5 font-utility text-[10px] font-semibold uppercase tracking-[0.1em] text-sonar"
            >
              {tag} ×
            </button>
          </div>
        ) : null}
      </Toolbar>

      {/* Bulk actions appear only after a selection (Design PRD §5.5). */}
      <MembersBulkActions members={selectedRows} branchId={branchId} onClear={() => setSelected(new Set())} />

      {data.items.length === 0 ? (
        <EmptyState
          title="No members match"
          body={
            search || lifecycle !== 'all' || risk !== 'any' || filters.joined || filters.expiring || tag
              ? 'Nothing fits those filters. Widen them, or clear the search.'
              : 'This branch has no members yet. Convert a lead to get started.'
          }
          action={
            search || lifecycle !== 'all' || risk !== 'any' || filters.joined || filters.expiring || tag ? (
              <Button
                variant="outline"
                onClick={() => {
                  void navigate({ search: () => ({ lifecycle: 'all', risk: 'any' }), replace: true });
                }}
              >
                Clear filters
              </Button>
            ) : (
              <Link to="/leads">
                <Button variant="cta">Open leads</Button>
              </Link>
            )
          }
        />
      ) : (
        <TableScroll><Table>
          <thead>
            <tr>
              <th className="w-8">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = selectedRows.length > 0 && !allSelected;
                  }}
                  onChange={toggleAll}
                  aria-label={allSelected ? 'Clear selection' : 'Select all shown'}
                  className="h-4 w-4 accent-[var(--sf-sonar)]"
                />
              </th>
              <th>Member</th>
              <th>Plan</th>
              <th>Last seen</th>
              <th>Coach</th>
              {data.columns.balanceVisible ? <th className="text-right">Balance</th> : null}
              <th>Risk</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((m) => (
              <tr key={m.id} data-selected={selected.has(m.id)}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.has(m.id)}
                    onChange={() => toggle(m.id)}
                    aria-label={`Select ${m.name}`}
                    className="h-4 w-4 accent-[var(--sf-sonar)]"
                  />
                </td>
                <td>
                  <Link to="/members/$memberId" params={{ memberId: m.id }} className="flex items-center gap-2.5 hover:text-sonar">
                    <span className="grid h-7 w-7 flex-none place-items-center border border-line-strong font-utility text-[10px] font-semibold">
                      {m.initials}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[13px]">{m.name}</span>
                      <span className="block font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
                        {m.memberNo} · {m.branchName}
                      </span>
                    </span>
                  </Link>
                  {m.tags.length > 0 ? (
                    <div className="mt-1 flex flex-wrap gap-1 pl-[38px]">
                      {/* A tag is also a filter: one click shows everyone who has it. */}
                      {m.tags.map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => setFilters({ tag: t })}
                          title={`Show members tagged ${t}`}
                          className="border border-line px-1.5 font-utility text-[9px] uppercase tracking-[0.1em] text-foam-45 hover:border-sonar hover:text-sonar"
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </td>
                <td>
                  <div className="flex items-center gap-1.5">
                    {m.membershipState ? (
                      <Chip tone={STATE_TONE[m.membershipState] ?? 'neutral'}>{m.membershipState.replace(/_/g, ' ')}</Chip>
                    ) : (
                      <Chip tone="neutral">none</Chip>
                    )}
                  </div>
                  <div className="mt-1 text-[11px] text-foam-45">
                    {m.productName ?? '—'}
                    {m.endsOn ? ` · ends ${m.endsOn}` : ''}
                    {m.autoRenew === false ? ' · no renew' : ''}
                  </div>
                </td>
                <td>
                  <span className={cx('text-[12px]', (m.daysSinceVisit ?? 0) > 14 ? 'text-flare' : 'text-foam-65')}>
                    {m.lastVisitLabel}
                  </span>
                </td>
                <td className="text-[12px] text-foam-65">{m.trainerName ?? '—'}</td>
                {data.columns.balanceVisible ? (
                  <td data-numeric>
                    {m.balanceLabel ? (
                      <span className="font-display text-[14px] text-chum">{m.balanceLabel}</span>
                    ) : (
                      <span className="text-foam-25">—</span>
                    )}
                  </td>
                ) : null}
                <td>
                  {m.riskBand && m.riskBand !== 'low' ? (
                    <span title={m.riskReasons.join(' · ')}>
                      <Chip tone={m.riskBand === 'high' ? 'bad' : 'warn'}>
                        {m.riskBand} {m.riskScore}
                      </Chip>
                    </span>
                  ) : (
                    <span className="text-foam-25">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table></TableScroll>
      )}

      <nav aria-label="Member directory pages" className="flex items-center justify-between gap-3 border-t border-line p-3.5">
        <Button variant="outline" disabled={isFetching || offset === 0}
          onClick={() => setFilters({ offset: Math.max(0, offset - data.limit) })}>Previous page</Button>
        <span className="text-[12px] text-foam-65">
          {data.items.length ? data.offset + 1 : 0}–{data.offset + data.items.length} of {data.total}
        </span>
        <Button variant="outline" disabled={isFetching || offset + data.limit >= data.total}
          onClick={() => setFilters({ offset: offset + data.limit })}>Next page</Button>
      </nav>

      {!data.columns.balanceVisible ? (
        <Panel className="border-t border-line">
          <p className="px-3.5 py-2.5 text-[12px] text-foam-45">
            Balances are hidden for your role. Reception and above can see what a member owes.
          </p>
        </Panel>
      ) : null}
    </Page>
  );
}

function MembersSkeleton() {
  return (
    <Page title="Members" kicker="Loading">
      <Seam className="border-b border-line">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="min-w-[150px] flex-1 px-3.5 py-3">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-2 h-6 w-12" />
          </div>
        ))}
      </Seam>
      <div className="border-b border-line p-3.5">
        <Skeleton className="h-9 w-full" />
      </div>
      {Array.from({ length: 10 }, (_, i) => (
        <Skeleton key={i} className="mx-3.5 my-2 h-9" />
      ))}
    </Page>
  );
}
