import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAdmin } from '../lib/store';
import { Page } from '../ui/shell';
import {
  BulkBar,
  Button,
  Chip,
  EmptyState,
  ErrorState,
  Field,
  Label,
  Metric,
  Panel,
  Seam,
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

const LIFECYCLES = ['all', 'active', 'trial', 'frozen', 'grace', 'expired', 'former'] as const;

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
  const branchId = useAdmin((s) => s.activeBranchId);
  const [search, setSearch] = useState('');
  const [lifecycle, setLifecycle] = useState<string>('all');
  const [risk, setRisk] = useState<'any' | 'high' | 'watch'>('any');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const params = new URLSearchParams();
  if (search.trim()) params.set('q', search.trim());
  if (lifecycle !== 'all') params.set('lifecycle', lifecycle);
  if (risk !== 'any') params.set('risk', risk);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['members', branchId, search, lifecycle, risk],
    queryFn: () => api<MembersPayload>(`/admin/members?${params}`, { branchId }),
    placeholderData: keepPreviousData,
  });

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

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
          <Label>High risk</Label>
          <div className="mt-1.5">
            <Metric value={atRisk} size="md" tone={atRisk > 0 ? 'warn' : 'default'} />
          </div>
        </div>
        {data.columns.balanceVisible ? (
          <div className="min-w-[150px] flex-1 px-3.5 py-3">
            <Label>With a balance</Label>
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
          onChange={(e) => setSearch(e.target.value)}
          className="min-w-[260px]"
        />

        <div className="flex flex-col gap-1">
          <Label>Lifecycle</Label>
          <div className="flex">
            {LIFECYCLES.map((l, i) => (
              <button
                key={l}
                type="button"
                onClick={() => setLifecycle(l)}
                aria-pressed={lifecycle === l}
                className={cx(
                  'min-h-9 border border-line px-2.5 font-utility text-[10px] font-semibold uppercase tracking-[0.1em] transition-colors',
                  i > 0 && '-ml-px',
                  lifecycle === l ? 'z-10 border-sonar text-sonar' : 'text-foam-45 hover:text-foam',
                )}
              >
                {l}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <Label>Risk</Label>
          <div className="flex">
            {(['any', 'watch', 'high'] as const).map((r, i) => (
              <button
                key={r}
                type="button"
                onClick={() => setRisk(r)}
                aria-pressed={risk === r}
                className={cx(
                  'min-h-9 border border-line px-2.5 font-utility text-[10px] font-semibold uppercase tracking-[0.1em] transition-colors',
                  i > 0 && '-ml-px',
                  risk === r ? 'z-10 border-sonar text-sonar' : 'text-foam-45 hover:text-foam',
                )}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      </Toolbar>

      {/* Bulk actions appear only after a selection (Design PRD §5.5). */}
      <BulkBar count={selected.size} onClear={() => setSelected(new Set())}>
        <Button variant="outline">Add tag</Button>
        <Button variant="outline">Assign trainer</Button>
        <Button variant="outline">Message</Button>
        <Button variant="outline">Export</Button>
      </BulkBar>

      {data.items.length === 0 ? (
        <EmptyState
          title="No members match"
          body={
            search || lifecycle !== 'all' || risk !== 'any'
              ? 'Nothing fits those filters. Widen them, or clear the search.'
              : 'This branch has no members yet. Convert a lead to get started.'
          }
          action={
            search || lifecycle !== 'all' || risk !== 'any' ? (
              <Button
                variant="outline"
                onClick={() => {
                  setSearch('');
                  setLifecycle('all');
                  setRisk('any');
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
                <span className="sr-only">Select</span>
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
