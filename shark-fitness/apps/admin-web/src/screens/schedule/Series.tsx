import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../../lib/api';
import { useBranchScope, usePermission } from '../../lib/store';
import {
  Button,
  Checkbox,
  Chip,
  EmptyState,
  ErrorState,
  Field,
  Label,
  Panel,
  PermissionState,
  SelectField,
  Skeleton,
  Table,
  TableScroll,
  TD,
  TH,
  THead,
  TR,
  Toolbar,
  cx,
} from '../../ui/console';
import { useIdempotentAttempt } from '../../lib/idempotent-attempt';

/**
 * Recurring classes — PF-SCH.
 *
 * The rule, not the occurrences. The day grid next door operates individual
 * classes; this screen is where a timetable is *stated* — "Spin, Tuesdays and
 * Thursdays, 18:30, Cycle Studio, Nikhil" — and the server generates from it.
 *
 * Two things are surfaced deliberately rather than hidden, because both are
 * how a manager finds out something is wrong before a member does:
 *
 * - **Skipped occurrences.** A week where the room was already taken is
 *   reported by date with the reason, instead of the series quietly having a
 *   hole in it.
 * - **What an edit will not touch.** Occurrences with people booked on them
 *   are left exactly as they are, and the screen says so before the edit
 *   rather than after.
 */

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

interface SeriesRow {
  id: string;
  branchId: string;
  className: string;
  roomName: string | null;
  trainerId: string | null;
  weekdays: number[];
  weekdayLabel: string;
  interval: number;
  startTime: string;
  durationMin: number;
  capacity: number;
  startDate: string;
  endDate: string | null;
  occurrenceCount: number | null;
  state: string;
  generatedThrough: string | null;
  supersedesSeriesId: string | null;
  supersededBySeriesId: string | null;
  upcoming: number;
}

interface Resources {
  classTypes: Array<{ id: string; name: string; durationMin: number }>;
  rooms: Array<{ id: string; name: string; branchId: string; capacity: number }>;
  trainers: Array<{ id: string; name: string; branchIds: string[] }>;
  branches: Array<{ id: string; name: string }>;
}

interface Generation {
  created: string[];
  skippedExisting: string[];
  skippedConflict: Array<{ date: string; reason: string }>;
  skippedPast: string[];
  generatedThrough: string;
}

interface SeriesDetail {
  series: SeriesRow & { notes: string | null };
  weekdayLabel: string;
  occurrences: Array<{
    id: string;
    occurrenceDate: string | null;
    startsAt: number;
    state: string;
    capacity: number;
    booked: number;
    cancelledReason: string | null;
    past: boolean;
    edited: boolean;
  }>;
}

export default function SeriesSurface() {
  const { branchId } = useBranchScope();
  const canView = usePermission('schedule.view');
  const canManage = usePermission('schedule.manage');
  const queryClient = useQueryClient();

  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [includeEnded, setIncludeEnded] = useState(false);

  const list = useQuery({
    queryKey: ['schedule', 'series', branchId, includeEnded],
    queryFn: () =>
      api<{ series: SeriesRow[] }>(
        `/admin/schedule/series?includeEnded=${includeEnded ? 'true' : 'false'}`,
        { branchId },
      ),
    enabled: canView,
  });

  const resources = useQuery({
    queryKey: ['schedule', 'resources', branchId],
    queryFn: () => api<Resources>('/admin/schedule/resources', { branchId }),
    enabled: canView,
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['schedule'] });
  };

  const fail = (err: unknown): void =>
    setActionError(err instanceof ApiError ? err.message : 'That did not go through. Nothing has changed.');

  if (!canView) {
    return (
      <Panel title="Recurring classes">
        <PermissionState what="The timetable" />
      </Panel>
    );
  }

  if (list.isLoading || resources.isLoading) return <Skeleton className="h-64" />;
  if (list.error || !list.data) {
    return (
      <ErrorState
        title="The timetable could not be read"
        body={list.error instanceof ApiError ? list.error.message : 'The server did not answer.'}
        onRetry={() => void list.refetch()}
        requestId={list.error instanceof ApiError ? list.error.requestId : undefined}
      />
    );
  }

  const rows = list.data.series;

  return (
    <>
      {notice ? (
        <Panel tone="good" className="border-b border-line">
          <div className="flex items-start gap-3 px-3.5 py-2.5">
            <p className="flex-1 whitespace-pre-line text-[12px] leading-relaxed">{notice}</p>
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

      <Toolbar className="justify-between">
        <Checkbox
          label="Show ended and cancelled"
          checked={includeEnded}
          onChange={(event) => setIncludeEnded(event.target.checked)}
        />
        {canManage ? (
          <Button variant="cta" onClick={() => setCreating((v) => !v)}>
            {creating ? 'Close' : 'New recurring class'}
          </Button>
        ) : null}
      </Toolbar>

      {creating && canManage && resources.data ? (
        <CreateSeriesForm
          resources={resources.data}
          branchId={branchId}
          onCancel={() => setCreating(false)}
          onDone={(message) => {
            setCreating(false);
            setActionError(null);
            setNotice(message);
            refresh();
          }}
          onError={fail}
        />
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          title="No recurring classes"
          body="A recurring class states the rule once — the day, the time, the room and the coach — and the timetable is generated from it."
          action={
            canManage ? (
              <Button variant="cta" onClick={() => setCreating(true)}>
                New recurring class
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Panel title={`Recurring classes · ${rows.length}`}>
          <TableScroll>
            <Table label="Recurring classes">
              <THead>
                <TH>Class</TH>
                <TH>Days</TH>
                <TH>Time</TH>
                <TH>Room</TH>
                <TH numeric>Seats</TH>
                <TH>Runs</TH>
                <TH numeric>Upcoming</TH>
                <TH>State</TH>
                <TH><span className="sr-only">Actions</span></TH>
              </THead>
              <tbody>
                {rows.map((row) => (
                  <TR key={row.id}>
                    <TD>{row.className}</TD>
                    <TD>
                      {row.weekdayLabel}
                      {row.interval > 1 ? (
                        <span className="text-foam-45"> · every {row.interval} weeks</span>
                      ) : null}
                    </TD>
                    <TD>
                      {row.startTime}
                      <span className="text-foam-45"> · {row.durationMin}m</span>
                    </TD>
                    <TD>{row.roomName ?? '—'}</TD>
                    <TD numeric>{row.capacity}</TD>
                    <TD>
                      {row.startDate}
                      {row.endDate ? ` → ${row.endDate}` : row.occurrenceCount ? ` · ${row.occurrenceCount} classes` : ' → open'}
                    </TD>
                    <TD numeric>{row.upcoming}</TD>
                    <TD>
                      <Chip tone={row.state === 'active' ? 'good' : row.state === 'cancelled' ? 'bad' : 'neutral'}>
                        {row.state}
                      </Chip>
                    </TD>
                    <TD>
                      <Button variant="ghost" onClick={() => setOpen(open === row.id ? null : row.id)}>
                        {open === row.id ? 'Close' : 'Open'}
                      </Button>
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        </Panel>
      )}

      {open ? (
        <SeriesDetailPanel
          seriesId={open}
          branchId={branchId}
          canManage={canManage}
          onDone={(message) => {
            setActionError(null);
            setNotice(message);
            refresh();
          }}
          onError={fail}
        />
      ) : null}
    </>
  );
}

/** Turns a generation result into a sentence a manager can act on. Skipped
 *  weeks are named rather than summarised — "3 skipped" tells nobody which
 *  Tuesday has no class on it. */
function describeGeneration(generation: Generation): string {
  const parts = [`${generation.created.length} ${generation.created.length === 1 ? 'class' : 'classes'} scheduled through ${generation.generatedThrough}.`];
  if (generation.skippedConflict.length > 0) {
    parts.push(
      `Skipped ${generation.skippedConflict.map((row) => `${row.date} (${row.reason})`).join('; ')}`,
    );
  }
  if (generation.skippedPast.length > 0) {
    parts.push(`${generation.skippedPast.length} in the past were not created.`);
  }
  return parts.join('\n');
}

function CreateSeriesForm({
  resources,
  branchId,
  onCancel,
  onDone,
  onError,
}: {
  resources: Resources;
  branchId: string | null;
  onCancel: () => void;
  onDone: (message: string) => void;
  onError: (err: unknown) => void;
}) {
  const branches = resources.branches;
  const [branch, setBranch] = useState(branchId ?? branches[0]?.id ?? '');
  const [classTypeId, setClassTypeId] = useState(resources.classTypes[0]?.id ?? '');
  const [roomId, setRoomId] = useState('');
  const [trainerId, setTrainerId] = useState('');
  const [weekdays, setWeekdays] = useState<number[]>([0]);
  const [startTime, setStartTime] = useState('18:30');
  const [startDate, setStartDate] = useState(() => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10));
  const [ending, setEnding] = useState<'open' | 'date' | 'count'>('open');
  const [endDate, setEndDate] = useState('');
  const [occurrenceCount, setOccurrenceCount] = useState(10);
  const [capacity, setCapacity] = useState(12);
  const [interval, setInterval] = useState(1);

  const attempt = useIdempotentAttempt('admin-series');

  const rooms = resources.rooms.filter((room) => room.branchId === branch);
  const trainers = resources.trainers.filter((trainer) => trainer.branchIds.includes(branch));

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ series: { id: string }; generation: Generation }>('/admin/schedule/series', {
        method: 'POST',
        body,
        branchId: branch,
        idempotencyKey: attempt.keyFor(body),
      }),
    onSuccess: (result) => {
      attempt.retire();
      onDone(describeGeneration(result.generation));
    },
    onError,
  });

  const toggleDay = (index: number): void =>
    setWeekdays((current) =>
      current.includes(index) ? current.filter((d) => d !== index) : [...current, index].sort((a, b) => a - b),
    );

  const valid = branch && classTypeId && weekdays.length > 0 && capacity >= 1;

  return (
    <Panel title="New recurring class" className="border-b border-line">
      <div className="grid grid-cols-1 gap-3 p-3.5 lg:grid-cols-3">
        <SelectField
          label="Branch"
          value={branch}
          onChange={(event) => {
            setBranch(event.target.value);
            setRoomId('');
            setTrainerId('');
          }}
          options={branches.map((b) => ({ value: b.id, label: b.name }))}
        />
        <SelectField
          label="Class"
          value={classTypeId}
          onChange={(event) => setClassTypeId(event.target.value)}
          options={resources.classTypes.map((t) => ({ value: t.id, label: t.name }))}
        />
        <SelectField
          label="Room"
          value={roomId}
          onChange={(event) => setRoomId(event.target.value)}
          options={[
            { value: '', label: 'No room' },
            ...rooms.map((r) => ({ value: r.id, label: `${r.name} · seats ${r.capacity}` })),
          ]}
        />
        <SelectField
          label="Coach"
          value={trainerId}
          onChange={(event) => setTrainerId(event.target.value)}
          options={[
            { value: '', label: 'Unassigned' },
            ...trainers.map((t) => ({ value: t.id, label: t.name })),
          ]}
        />
        <Field label="Start time" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
        <Field
          label="Seats"
          type="number"
          min={1}
          max={500}
          value={capacity}
          onChange={(e) => setCapacity(Number(e.target.value))}
        />
      </div>

      <div className="border-t border-line px-3.5 py-3">
        <Label>Days of the week</Label>
        <div className="mt-2 flex flex-wrap gap-2">
          {WEEKDAYS.map((name, index) => (
            <button
              key={name}
              type="button"
              aria-pressed={weekdays.includes(index)}
              onClick={() => toggleDay(index)}
              className={cx(
                'min-h-11 border px-3 font-utility text-[11px] uppercase tracking-[0.12em] transition-colors',
                weekdays.includes(index)
                  ? 'border-sonar bg-wash-sonar text-sonar'
                  : 'border-line-strong text-foam-50 hover:border-sonar hover:text-sonar',
              )}
            >
              {name}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 border-t border-line p-3.5 lg:grid-cols-4">
        <Field label="First class on" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        <Field
          label="Repeat every (weeks)"
          type="number"
          min={1}
          max={12}
          value={interval}
          onChange={(e) => setInterval(Number(e.target.value))}
        />
        <SelectField
          label="Ends"
          value={ending}
          onChange={(event) => setEnding(event.target.value as 'open' | 'date' | 'count')}
          options={[
            { value: 'open', label: 'Runs until cancelled' },
            { value: 'date', label: 'On a date' },
            { value: 'count', label: 'After a number of classes' },
          ]}
        />
        {ending === 'date' ? (
          <Field label="Last class on or before" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        ) : ending === 'count' ? (
          <Field
            label="Number of classes"
            type="number"
            min={1}
            max={520}
            value={occurrenceCount}
            onChange={(e) => setOccurrenceCount(Number(e.target.value))}
          />
        ) : (
          <p className="self-end text-[11px] leading-relaxed text-foam-45">
            Classes are generated eight weeks ahead and rolled forward automatically.
          </p>
        )}
      </div>

      <Toolbar className="border-t">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="cta"
          disabled={!valid || create.isPending}
          onClick={() =>
            create.mutate({
              branchId: branch,
              classTypeId,
              roomId: roomId || null,
              trainerId: trainerId || null,
              weekdays,
              interval,
              startDate,
              endDate: ending === 'date' && endDate ? endDate : null,
              occurrenceCount: ending === 'count' ? occurrenceCount : null,
              startTime,
              capacity,
            })
          }
        >
          {create.isPending ? 'Scheduling…' : 'Create and generate'}
        </Button>
      </Toolbar>
    </Panel>
  );
}

function SeriesDetailPanel({
  seriesId,
  branchId,
  canManage,
  onDone,
  onError,
}: {
  seriesId: string;
  branchId: string | null;
  canManage: boolean;
  onDone: (message: string) => void;
  onError: (err: unknown) => void;
}) {
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [scope, setScope] = useState<'series' | 'future'>('series');
  const [fromSessionId, setFromSessionId] = useState('');

  const detail = useQuery({
    queryKey: ['schedule', 'series', seriesId],
    queryFn: () => api<SeriesDetail>(`/admin/schedule/series/${seriesId}`, { branchId }),
  });

  const cancel = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ cancelledSessions: string[]; bookingsReleased: number; creditsReturned: number; notified: number }>(
        `/admin/schedule/series/${seriesId}/cancel`,
        { method: 'POST', body, branchId },
      ),
    onSuccess: (result) => {
      setCancelling(false);
      setReason('');
      onDone(
        `Cancelled ${result.cancelledSessions.length} ${result.cancelledSessions.length === 1 ? 'class' : 'classes'}. ` +
          `${result.bookingsReleased} ${result.bookingsReleased === 1 ? 'seat' : 'seats'} released, ` +
          `${result.creditsReturned} returned, ${result.notified} members told. Classes that have already run are untouched.`,
      );
      void detail.refetch();
    },
    onError,
  });

  if (detail.isLoading) return <Skeleton className="h-48" />;
  if (detail.error || !detail.data) {
    return (
      <ErrorState
        title="That recurring class could not be read"
        body={detail.error instanceof ApiError ? detail.error.message : 'The server did not answer.'}
        onRetry={() => void detail.refetch()}
      />
    );
  }

  const { series, occurrences } = detail.data;
  const future = occurrences.filter((row) => !row.past && row.state !== 'cancelled');
  const bookedFuture = future.filter((row) => row.booked > 0);

  return (
    <Panel title={`${series.className} · ${detail.data.weekdayLabel} at ${series.startTime}`}>
      <div className="flex flex-wrap gap-6 border-b border-line px-3.5 py-3 text-[12px]">
        <div>
          <Label>Runs</Label>
          <div className="mt-1">
            {series.startDate}
            {series.endDate ? ` → ${series.endDate}` : ' → until cancelled'}
          </div>
        </div>
        <div>
          <Label>Generated through</Label>
          <div className="mt-1">{series.generatedThrough ?? '—'}</div>
        </div>
        <div>
          <Label>Upcoming</Label>
          <div className="mt-1">{future.length}</div>
        </div>
        <div>
          <Label>With people booked</Label>
          <div className="mt-1">{bookedFuture.length}</div>
        </div>
      </div>

      {series.supersedesSeriesId || series.supersededBySeriesId ? (
        <p className="border-b border-line px-3.5 py-2.5 text-[11px] leading-relaxed text-foam-45">
          {series.supersededBySeriesId
            ? 'This rule was changed partway through. Classes from the change onwards belong to a newer rule; the ones here are what was actually scheduled before it.'
            : 'This rule took over from an earlier one partway through. Earlier classes still describe what was scheduled at the time.'}
        </p>
      ) : null}

      {canManage ? (
        <Toolbar className="border-b">
          <Button variant="danger" onClick={() => setCancelling((v) => !v)} disabled={series.state === 'cancelled'}>
            {cancelling ? 'Close' : 'Cancel classes'}
          </Button>
        </Toolbar>
      ) : null}

      {cancelling ? (
        <div className="border-b border-line bg-wash-sonar-soft p-3.5">
          <p className="mb-3 text-[11px] leading-relaxed text-foam-45">
            Everyone booked in is told and made whole — seats released, credits returned — whatever the cancellation
            deadline says. Classes that have already run are never touched.
          </p>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <SelectField
              label="What to cancel"
              value={scope}
              onChange={(event) => setScope(event.target.value as 'series' | 'future')}
              options={[
                { value: 'series', label: 'Every remaining class' },
                { value: 'future', label: 'This class and every one after it' },
              ]}
            />
            {scope === 'future' ? (
              <SelectField
                label="Starting from"
                value={fromSessionId}
                onChange={(event) => setFromSessionId(event.target.value)}
                options={[
                  { value: '', label: 'Choose a class' },
                  ...future.map((row) => ({ value: row.id, label: row.occurrenceDate ?? row.id })),
                ]}
              />
            ) : null}
          </div>
          <Field
            label="Reason"
            className="mt-3"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="The studio floor is being replaced."
          />
          <Toolbar className="mt-3 -mx-3.5 -mb-3.5 border-t">
            <Button
              variant="danger"
              disabled={reason.trim().length < 4 || (scope === 'future' && !fromSessionId) || cancel.isPending}
              onClick={() =>
                cancel.mutate({
                  reason: reason.trim(),
                  scope,
                  ...(scope === 'future' ? { fromSessionId } : {}),
                })
              }
            >
              {cancel.isPending ? 'Cancelling…' : 'Cancel and notify'}
            </Button>
          </Toolbar>
        </div>
      ) : null}

      <TableScroll>
        <Table label="Occurrences">
          <THead>
            <TH>Date</TH>
            <TH>State</TH>
            <TH numeric>Booked</TH>
            <TH numeric>Seats</TH>
            <TH>Notes</TH>
          </THead>
          <tbody>
            {occurrences.map((row) => (
              <TR key={row.id}>
                <TD>{row.occurrenceDate ?? '—'}</TD>
                <TD>
                  <Chip
                    tone={
                      row.state === 'cancelled' ? 'bad' : row.past ? 'neutral' : row.booked > 0 ? 'good' : 'accent'
                    }
                  >
                    {row.state}
                  </Chip>
                </TD>
                <TD numeric>{row.booked}</TD>
                <TD numeric>{row.capacity}</TD>
                <TD>
                  {row.cancelledReason ??
                    (row.past
                      ? 'Already run — never changed by an edit'
                      : row.edited
                        ? 'Changed on its own, away from the rule'
                        : '')}
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      </TableScroll>
    </Panel>
  );
}
