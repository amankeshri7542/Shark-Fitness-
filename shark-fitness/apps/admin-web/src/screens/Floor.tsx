import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api';
import { useBranchScope, useBranchTimeZone, usePermission } from '../lib/store';
import { useOnline } from '../lib/realtime';
import { Page } from '../ui/shell';
import {
  Bar,
  Button,
  Chip,
  Display,
  EmptyState,
  ErrorState,
  Eyebrow,
  Field,
  Freshness,
  Label,
  Metric,
  Panel,
  PermissionState,
  Skeleton,
  Toolbar,
  cx,
} from '../ui/console';

/**
 * Attendance and Live Occupancy — UX-A08.
 *
 * The screen is ordered the way the desk works, not the way the data is
 * shaped: admit someone, see the room, see who is in it, deal with the
 * refusals. Denials sit in the same feed as entries rather than behind a tab,
 * because resolving one is the job — hiding them one click away is how a
 * member ends up standing at a desk while nobody notices.
 *
 * Every action resolves inline. Front-desk work is interrupted constantly and
 * a modal would bury the queue behind the thing you are trying to fix.
 */

type Filter = 'all' | 'granted' | 'denied' | 'overridden';

interface BranchOccupancy {
  branchId: string;
  branchName: string;
  inside: number;
  capacity: number;
  label: 'quiet' | 'steady' | 'busy' | 'peak';
}

interface CurrentPayload {
  at: string;
  totals: { inside: number; capacity: number };
  branches: BranchOccupancy[];
  items: Array<{
    checkInId: string;
    branchId: string;
    memberId: string | null;
    memberNo: string | null;
    name: string;
    initials: string;
    method: string;
    enteredAt: string;
    minutesInside: number;
    visitNumber: number | null;
    overrideByName: string | null;
    overrideReason: string | null;
  }>;
}

interface FeedPayload {
  date: string | null;
  filter: Filter;
  total: number;
  hasMore: boolean;
  breakdown: Partial<Record<Filter, number>>;
  items: Array<{
    checkInId: string;
    memberId: string | null;
    memberNo: string | null;
    name: string;
    initials: string;
    method: string;
    decision: string;
    granted: boolean;
    canOverride: boolean;
    enteredAt: string;
    exitedAt: string | null;
    durationMin: number | null;
    autoClosed: boolean;
    inside: boolean;
    overrideByName: string | null;
    overrideReason: string | null;
    visitNumber: number | null;
  }>;
}

interface SearchPayload {
  items: Array<{
    memberId: string;
    memberNo: string;
    name: string;
    initials: string;
    homeBranchId: string;
    lifecycle: string;
    insideSince: string | null;
  }>;
}

const OCCUPANCY_TONE = { quiet: 'good', steady: 'accent', busy: 'warn', peak: 'bad' } as const;

/** A denial reason the desk can read at a glance. The server sends the code;
 *  the member-facing sentence comes back with the check-in attempt itself. */
const DECISION_LABEL: Record<string, string> = {
  granted: 'Allowed',
  denied_membership_inactive: 'Membership inactive',
  denied_grace_outstanding: 'Balance outstanding',
  denied_branch_not_permitted: 'Wrong branch',
  denied_outside_hours: 'Outside plan hours',
  denied_capacity: 'At capacity',
  denied_suspended: 'Suspended',
  denied_anti_passback: 'Just checked in',
  denied_token_invalid: 'Code expired',
  denied_token_replayed: 'Code reused',
};

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export default function FloorScreen() {
  const canView = usePermission('attendance.view');
  const canCheckIn = usePermission('attendance.checkin');
  const canOverride = usePermission('attendance.override');
  const { branchId, branchName } = useBranchScope();
  const timeZone = useBranchTimeZone();
  const online = useOnline();
  const queryClient = useQueryClient();

  // The Command Center links here as /floor?filter=denied when denials spike.
  const [filter, setFilter] = useState<Filter>(() => {
    const requested = new URLSearchParams(window.location.search).get('filter');
    return requested === 'denied' || requested === 'granted' || requested === 'overridden' ? requested : 'all';
  });
  const [search, setSearch] = useState('');
  const [overrideFor, setOverrideFor] = useState<string | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const current = useQuery({
    queryKey: ['floor', 'current', branchId],
    queryFn: () => api<CurrentPayload>('/admin/attendance/current', { branchId }),
    enabled: canView,
    refetchInterval: 60_000,
  });

  const feed = useQuery({
    queryKey: ['floor', 'feed', branchId, filter],
    queryFn: () => api<FeedPayload>(`/admin/attendance?filter=${filter}&limit=60`, { branchId }),
    enabled: canView,
  });

  const lookup = useQuery({
    queryKey: ['floor', 'search', branchId, search.trim()],
    queryFn: () => api<SearchPayload>(`/admin/attendance/search?q=${encodeURIComponent(search.trim())}`, { branchId }),
    enabled: canView && canCheckIn && search.trim().length >= 2,
  });

  const refreshFloor = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['floor'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const fail = (err: unknown): void => {
    setActionError(err instanceof ApiError ? err.message : 'That did not go through. Nothing has changed.');
  };

  const checkIn = useMutation({
    mutationFn: (input: { memberId: string; branchId: string }) =>
      api<{ granted: boolean; message: string | null; member: { name: string }; replayed: boolean }>(
        '/admin/attendance/check-in',
        { method: 'POST', body: { ...input, method: 'staff' }, branchId },
      ),
    onSuccess: (result) => {
      setActionError(null);
      setNotice(
        result.granted
          ? `${result.member.name} is in.${result.replayed ? ' (Already recorded.)' : ''}`
          : (result.message ?? 'Entry refused.'),
      );
      setSearch('');
      refreshFloor();
    },
    onError: fail,
  });

  const checkOut = useMutation({
    mutationFn: (checkInId: string) =>
      api<{ durationMin: number; member: { name: string } | null }>('/admin/attendance/check-out', {
        method: 'POST',
        body: { checkInId },
        branchId,
      }),
    onSuccess: (result) => {
      setActionError(null);
      setNotice(`${result.member?.name ?? 'Member'} checked out after ${result.durationMin} min.`);
      refreshFloor();
    },
    onError: fail,
  });

  const override = useMutation({
    mutationFn: (input: { checkInId: string; reason: string }) =>
      api<{ member: { name: string } }>('/admin/attendance/override', { method: 'POST', body: input, branchId }),
    onSuccess: (result) => {
      setActionError(null);
      setNotice(`${result.member.name} was let in. The reason is on the record.`);
      setOverrideFor(null);
      setOverrideReason('');
      refreshFloor();
    },
    onError: fail,
  });

  const closeAll = useMutation({
    mutationFn: (input: { branchId: string; reason: string }) =>
      api<{ closed: number }>('/admin/attendance/close-all', { method: 'POST', body: input, branchId }),
    onSuccess: (result) => {
      setActionError(null);
      setNotice(`Closed ${result.closed} open ${result.closed === 1 ? 'visit' : 'visits'}.`);
      refreshFloor();
    },
    onError: fail,
  });

  if (!canView) {
    return (
      <Page title="Floor">
        <PermissionState what="Attendance and live occupancy" />
      </Page>
    );
  }

  if (current.isLoading) {
    return (
      <Page title="Floor" kicker="Loading">
        <div className="flex flex-col gap-3 p-4">
          <Skeleton className="h-28" />
          <Skeleton className="h-14" />
          <Skeleton className="h-64" />
        </div>
      </Page>
    );
  }

  if (current.error || !current.data) {
    return (
      <Page title="Floor">
        <ErrorState
          title="Could not read the floor"
          body="The API did not answer, so this would be a guess. Nobody has been checked in or out."
          onRetry={() => void current.refetch()}
          requestId={current.error instanceof ApiError ? current.error.requestId : undefined}
        />
      </Page>
    );
  }

  const { totals, branches, items: inside } = current.data;
  const atCapacity = totals.capacity > 0 && totals.inside >= totals.capacity;

  return (
    <Page
      title="Floor"
      kicker={branchName}
      actions={<Freshness kind="realtime" asOf={current.data.at} timeZone={timeZone} />}
    >
      {/* Network state is a first-class condition at a desk: "nothing is
          happening" and "this machine is offline" must never look the same. */}
      {!online ? (
        <Panel tone="bad" className="border-b border-line">
          <p className="px-3.5 py-2.5 text-[12px] leading-relaxed">
            This machine is offline. The numbers below are the last ones received, and check-ins cannot be recorded until
            the connection returns.
          </p>
        </Panel>
      ) : null}

      {notice ? (
        <Panel tone="good" className="border-b border-line">
          <div className="flex items-center gap-3 px-3.5 py-2.5">
            <p className="flex-1 text-[12px] leading-relaxed">{notice}</p>
            <Button variant="ghost" onClick={() => setNotice(null)}>
              Dismiss
            </Button>
          </div>
        </Panel>
      ) : null}

      {actionError ? (
        <Panel tone="bad" className="border-b border-line">
          <div className="flex items-center gap-3 px-3.5 py-2.5">
            <p className="flex-1 text-[12px] leading-relaxed">{actionError}</p>
            <Button variant="ghost" onClick={() => setActionError(null)}>
              Dismiss
            </Button>
          </div>
        </Panel>
      ) : null}

      {/* — 1. Check-in surface ————————————————————————————————— */}

      <Panel title="Check someone in" className="border-b border-line">
        {canCheckIn ? (
          <div className="flex flex-col gap-3 p-3.5">
            <Field
              label="Find a member"
              placeholder="Name, member number or phone"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              hint="The door reader handles app passes. This is for members without one."
              className="max-w-[380px]"
            />

            {search.trim().length >= 2 ? (
              lookup.isLoading ? (
                <Skeleton className="h-16" />
              ) : lookup.data && lookup.data.items.length > 0 ? (
                <ul className="flex flex-col border border-line">
                  {lookup.data.items.map((row) => (
                    <li
                      key={row.memberId}
                      className="flex items-center gap-3 border-b border-line-10 px-3 py-2 last:border-b-0"
                    >
                      <span className="grid h-8 w-8 flex-none place-items-center border border-line-strong font-utility text-[10px] font-semibold">
                        {row.initials}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px]">{row.name}</div>
                        <div className="font-utility text-[10px] uppercase tracking-[0.12em] text-foam-35">
                          {row.memberNo} · {row.lifecycle}
                        </div>
                      </div>
                      {row.insideSince ? (
                        <Chip tone="accent">Inside since {timeOf(row.insideSince)}</Chip>
                      ) : (
                        <Button
                          variant="cta"
                          disabled={!online || checkIn.isPending}
                          onClick={() => checkIn.mutate({ memberId: row.memberId, branchId: row.homeBranchId })}
                        >
                          Check in
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[12px] text-foam-45">
                  Nobody matches “{search.trim()}”. Try a member number, or check the branch selector above.
                </p>
              )
            ) : null}
          </div>
        ) : (
          <PermissionState what="Checking members in" />
        )}
      </Panel>

      {/* — 2. Occupancy ————————————————————————————————————————— */}

      <Panel
        title="In the building"
        tone={atCapacity ? 'bad' : 'plain'}
        className="border-b border-line"
        action={
          canOverride && branchId ? (
            <Button
              variant="danger"
              disabled={!online || closeAll.isPending || totals.inside === 0}
              onClick={() => {
                const reason = window.prompt(
                  'Closing every open visit at this branch. This is for an evacuation or a closing sweep — each person closed is recorded against you.\n\nReason:',
                );
                if (reason && reason.trim().length >= 4) closeAll.mutate({ branchId, reason: reason.trim() });
              }}
            >
              Close all visits
            </Button>
          ) : null
        }
      >
        <div className="flex flex-wrap items-end gap-8 p-3.5">
          <div>
            <Label>Currently inside</Label>
            <div className="mt-1 flex items-baseline gap-2">
              <Metric value={totals.inside} size="lg" tone={atCapacity ? 'bad' : 'accent'} />
              <span className="text-[13px] text-foam-45">of {totals.capacity}</span>
            </div>
          </div>

          <div className="min-w-[220px] flex-1">
            <Bar
              value={totals.inside}
              max={Math.max(1, totals.capacity)}
              tone={atCapacity ? 'bad' : totals.inside / Math.max(1, totals.capacity) > 0.85 ? 'warn' : 'accent'}
            />
            {atCapacity ? (
              <p className="mt-2 text-[12px] leading-relaxed text-chum">
                At capacity. New entries are refused until someone leaves — a manager can override an individual refusal.
              </p>
            ) : null}
          </div>
        </div>

        {branches.length > 1 ? (
          <div className="grid grid-cols-2 gap-px border-t border-line bg-[var(--sf-line)] md:grid-cols-4">
            {branches.map((b) => (
              <div key={b.branchId} className="bg-hull px-3.5 py-2.5">
                <div className="truncate font-utility text-[10px] uppercase tracking-[0.12em] text-foam-45">
                  {b.branchName}
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <Metric value={b.inside} size="sm" />
                  <span className="text-[11px] text-foam-35">/ {b.capacity}</span>
                  <Chip tone={OCCUPANCY_TONE[b.label]}>{b.label}</Chip>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </Panel>

      {/* — 3. Who is inside ————————————————————————————————————— */}

      <Panel title={`Inside now · ${inside.length}`} className="border-b border-line">
        {inside.length === 0 ? (
          <EmptyState
            title="Nobody is inside"
            body="Check-ins appear here the moment they happen, whether they come from the door reader or this desk."
          />
        ) : (
          <ul className="flex flex-col">
            {inside.map((row) => (
              <li key={row.checkInId} className="flex items-center gap-3 border-b border-line-10 px-3.5 py-2.5">
                <span className="grid h-8 w-8 flex-none place-items-center border border-line-strong font-utility text-[10px] font-semibold">
                  {row.initials}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px]">{row.name}</div>
                  <div className="font-utility text-[10px] uppercase tracking-[0.12em] text-foam-35">
                    {row.memberNo ?? '—'} · in at {timeOf(row.enteredAt)} · {row.minutesInside} min
                    {row.overrideByName ? ` · let in by ${row.overrideByName}` : ''}
                  </div>
                </div>
                <Chip tone="neutral">{row.method}</Chip>
                {/* A visit open far longer than a session is usually a missed
                    tap-out, not a marathon. Say so rather than ranking it. */}
                {row.minutesInside > 180 ? <Chip tone="warn">Stale</Chip> : null}
                {canCheckIn ? (
                  <Button
                    variant="outline"
                    disabled={!online || checkOut.isPending}
                    onClick={() => checkOut.mutate(row.checkInId)}
                  >
                    Check out
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* — 4. The door feed, denials included ——————————————————— */}

      <Panel title="Today at the door">
        <Toolbar>
          {(['all', 'denied', 'granted', 'overridden'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              aria-pressed={filter === value}
              className={cx(
                'min-h-9 border px-2.5 font-utility text-[10px] font-semibold uppercase tracking-[0.12em] transition-colors',
                filter === value
                  ? 'border-sonar bg-wash-sonar text-sonar'
                  : 'border-line-strong text-foam-50 hover:border-sonar hover:text-sonar',
              )}
            >
              {value}
              {feed.data?.breakdown[value] !== undefined ? (
                <span className="ml-1.5 text-foam-35">{feed.data.breakdown[value]}</span>
              ) : null}
            </button>
          ))}
        </Toolbar>

        {feed.isLoading ? (
          <div className="flex flex-col gap-2 p-3.5">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : feed.error || !feed.data ? (
          <ErrorState
            title="Could not load the door feed"
            body="Occupancy above is still accurate. Only this list failed to load."
            onRetry={() => void feed.refetch()}
          />
        ) : feed.data.items.length === 0 ? (
          <EmptyState
            title={filter === 'all' ? 'No entries today' : `No ${filter} entries today`}
            body={
              filter === 'denied'
                ? 'Nothing has been refused today. Refusals show here with the reason and, where allowed, a way to let the member in.'
                : 'Entries appear here as they happen.'
            }
          />
        ) : (
          <ul className="flex flex-col">
            {feed.data.items.map((row) => {
              const isOverriding = overrideFor === row.checkInId;
              return (
                <li key={row.checkInId} className="border-b border-line-10">
                  <div className="flex items-center gap-3 px-3.5 py-2.5">
                    <span className="w-12 flex-none font-utility text-[11px] tabular-nums text-foam-45">
                      {timeOf(row.enteredAt)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px]">{row.name}</div>
                      <div className="font-utility text-[10px] uppercase tracking-[0.12em] text-foam-35">
                        {row.memberNo ?? '—'} · {row.method}
                        {row.durationMin !== null ? ` · ${row.durationMin} min` : ''}
                        {row.autoClosed ? ' · closed automatically' : ''}
                      </div>
                      {row.overrideReason ? (
                        <div className="mt-1 text-[11px] leading-relaxed text-foam-50">
                          Let in by {row.overrideByName}: “{row.overrideReason}”
                        </div>
                      ) : null}
                    </div>

                    {row.granted ? (
                      <Chip tone={row.overrideReason ? 'warn' : 'good'}>
                        {row.overrideReason ? 'Overridden' : 'Allowed'}
                      </Chip>
                    ) : (
                      <Chip tone="bad">{DECISION_LABEL[row.decision] ?? 'Refused'}</Chip>
                    )}

                    {row.inside ? <Chip tone="accent">Inside</Chip> : null}

                    {!row.granted && row.canOverride && canOverride ? (
                      <Button variant="outline" onClick={() => setOverrideFor(isOverriding ? null : row.checkInId)}>
                        {isOverriding ? 'Cancel' : 'Let in'}
                      </Button>
                    ) : null}

                    {/* A reused code is the one refusal staff must not wave
                        through, so say why the action is missing. */}
                    {row.decision === 'denied_token_replayed' ? (
                      <span className="font-utility text-[9px] uppercase tracking-[0.12em] text-foam-35">
                        Ask for a fresh code
                      </span>
                    ) : null}
                  </div>

                  {isOverriding ? (
                    <div className="flex flex-col gap-2 border-t border-line bg-wash-flare px-3.5 py-3">
                      <Eyebrow>Override</Eyebrow>
                      <p className="max-w-[62ch] text-[12px] leading-relaxed text-foam-65">
                        This lets {row.name} in against the refusal above. The reason is recorded against your name and
                        cannot be edited afterwards.
                      </p>
                      <Field
                        label="Reason"
                        placeholder="Paying at the desk now — receipt SF-2026-00291"
                        value={overrideReason}
                        onChange={(e) => setOverrideReason(e.target.value)}
                        className="max-w-[460px]"
                      />
                      <div className="flex items-center gap-2">
                        <Button
                          variant="cta"
                          disabled={!online || overrideReason.trim().length < 4 || override.isPending}
                          onClick={() => override.mutate({ checkInId: row.checkInId, reason: overrideReason.trim() })}
                        >
                          Let them in
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setOverrideFor(null);
                            setOverrideReason('');
                          }}
                        >
                          Cancel
                        </Button>
                        {overrideReason.trim().length > 0 && overrideReason.trim().length < 4 ? (
                          <span className="text-[11px] text-chum">A few more characters, so the record means something.</span>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        {feed.data?.hasMore ? (
          <p className="border-t border-line px-3.5 py-2.5 text-[12px] text-foam-45">
            Showing {feed.data.items.length} of {feed.data.total}. Narrow the filter to see the rest.
          </p>
        ) : null}
      </Panel>

      <div className="px-3.5 py-3">
        <Display size="sm" as="h3" className="sr-only">
          Scanning
        </Display>
        <p className="max-w-[70ch] text-[11px] leading-relaxed text-foam-35">
          Camera scanning is not part of this screen. App passes are read by the door reader, which validates the signed
          code and its replay window server-side; this desk covers the members that reader cannot help.
        </p>
      </div>
    </Page>
  );
}
