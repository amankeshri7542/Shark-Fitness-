import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api';
import { useBranchScope, usePermission } from '../lib/store';
import { Page } from '../ui/shell';
import {
  Bar,
  Button,
  Chip,
  EmptyState,
  ErrorState,
  Eyebrow,
  Field,
  Label,
  Metric,
  Panel,
  PermissionState,
  Skeleton,
  Toolbar,
  cx,
} from '../ui/console';
import { useIdempotentAttempt } from '../lib/idempotent-attempt';

/**
 * Calendar and class operations — UX-A09.
 *
 * The console operates classes; it does not sell seats. So the centre of this
 * screen is the roster: who is in the room, who is waiting, and who actually
 * turned up. That is the one thing the member app cannot do, and it is what a
 * manager opens this screen for.
 *
 * A session expands in place rather than opening a dialog. Running a timetable
 * means comparing one class against the ones around it, and a modal hides
 * exactly the context that makes the decision obvious.
 */

interface SessionRow {
  id: string;
  branchId: string;
  branchName: string;
  name: string;
  category: string;
  roomName: string;
  trainerId: string | null;
  trainerName: string;
  startsAt: string;
  localTime: string;
  localEndTime: string;
  durationMin: number;
  capacity: number;
  booked: number;
  seatsLeft: number;
  fillPct: number;
  waitlistCount: number;
  state: string;
  cancelledReason: string | null;
  substituted: boolean;
  creditsRequired: number;
  version: number;
  started: boolean;
}

interface DayPayload {
  date: string;
  today: string;
  dateLabel: string;
  days: Array<{ date: string; weekday: string; dayNo: number; isToday: boolean }>;
  totals: { sessions: number; seats: number; booked: number; waitlisted: number; cancelled: number };
  items: SessionRow[];
}

interface DetailPayload {
  session: SessionRow & { notes: string | null; seriesId: string | null; waitlistEnabled: boolean };
  counts: { live: number; attended: number; noShow: number; cancelled: number; waitlisted: number };
  roster: Array<{
    bookingId: string;
    memberId: string;
    memberNo: string;
    name: string;
    initials: string;
    state: string;
    seatNo: number | null;
    cameFromWaitlist: boolean;
  }>;
  waitlist: Array<{
    waitlistId: string;
    memberId: string;
    memberNo: string;
    name: string;
    initials: string;
    position: number;
    state: string;
    offerExpiresAt: string | null;
  }>;
}

interface Resources {
  trainers: Array<{ id: string; name: string }>;
}

const FILL_TONE = (pct: number): 'good' | 'accent' | 'warn' | 'bad' =>
  pct >= 100 ? 'bad' : pct >= 85 ? 'warn' : pct >= 40 ? 'accent' : 'good';

const ROSTER_TONE: Record<string, 'neutral' | 'accent' | 'good' | 'warn' | 'bad'> = {
  confirmed: 'accent',
  attended: 'good',
  no_show: 'bad',
  cancelled: 'neutral',
  late_cancelled: 'warn',
  held: 'warn',
};

export default function ScheduleScreen() {
  const canView = usePermission('schedule.view');
  const canManage = usePermission('schedule.manage');
  const canBookOthers = usePermission('booking.manage_others');
  const canMarkAttendance = usePermission('attendance.checkin');
  const { branchId, branchName } = useBranchScope();
  const queryClient = useQueryClient();

  const [date, setDate] = useState<string | null>(null);
  const [openSession, setOpenSession] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [bookMemberId, setBookMemberId] = useState('');
  const [bookOverride, setBookOverride] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [pendingCharge, setPendingCharge] = useState<{ memberId: string; dropInPriceMinor: number | null } | null>(null);
  // Booking-others is the ordinary desk action; the override additionally
  // needs schedule.manage, so reception can book members but never bypass
  // eligibility — that stays a manager-and-above call.
  const canOverrideBooking = canBookOthers && canManage;

  const day = useQuery({
    queryKey: ['schedule', 'day', branchId, date],
    queryFn: () => api<DayPayload>(`/admin/schedule${date ? `?date=${date}` : ''}`, { branchId }),
    enabled: canView,
  });

  const detail = useQuery({
    queryKey: ['schedule', 'session', openSession],
    queryFn: () => api<DetailPayload>(`/admin/schedule/session/${openSession}`, { branchId }),
    enabled: canView && openSession !== null,
  });

  const resources = useQuery({
    queryKey: ['schedule', 'resources', branchId],
    queryFn: () => api<Resources>('/admin/schedule/resources', { branchId }),
    enabled: canView && canManage,
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['schedule'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const fail = (err: unknown): void =>
    setActionError(err instanceof ApiError ? err.message : 'That did not go through. Nothing has changed.');

  const cancelSession = useMutation({
    mutationFn: (input: { sessionId: string; reason: string; scope: 'occurrence' | 'series' }) =>
      api<{ cancelled: string[]; bookingsReleased: number; creditsReturned: number; notified: number }>(
        `/admin/schedule/session/${input.sessionId}/cancel`,
        { method: 'POST', body: { reason: input.reason, scope: input.scope }, branchId },
      ),
    onSuccess: (r) => {
      setActionError(null);
      setNotice(
        `Cancelled ${r.cancelled.length} ${r.cancelled.length === 1 ? 'class' : 'classes'}. ` +
          `${r.bookingsReleased} ${r.bookingsReleased === 1 ? 'seat' : 'seats'} released, ` +
          `${r.creditsReturned} ${r.creditsReturned === 1 ? 'credit' : 'credits'} returned, ${r.notified} notified.`,
      );
      refresh();
    },
    onError: fail,
  });

  const substitute = useMutation({
    mutationFn: (input: { sessionId: string; trainerId: string }) =>
      api(`/admin/schedule/session/${input.sessionId}/substitute`, {
        method: 'POST',
        body: { trainerId: input.trainerId },
        branchId,
      }),
    onSuccess: () => {
      setActionError(null);
      setNotice('Cover assigned. Everyone booked in has been told.');
      refresh();
    },
    onError: fail,
  });

  /* This endpoint takes its key in the body rather than the header, so the
     fingerprint is the booking's identity — session, member, and whether a
     drop-in charge was consented to — and the key it mints is then placed
     inside the body that gets sent. */
  const bookAttempt = useIdempotentAttempt('admin-book');
  const bookMember = useMutation({
    mutationFn: (input: { sessionId: string; memberId: string; acceptDropInCharge?: boolean }) => {
      const identity = {
        sessionId: input.sessionId,
        memberId: input.memberId,
        acceptDropInCharge: input.acceptDropInCharge ?? false,
      };
      return api<{ replayed: boolean }>(`/admin/schedule/session/${input.sessionId}/book`, {
        method: 'POST',
        body: {
          memberId: input.memberId,
          idempotencyKey: bookAttempt.keyFor(identity),
          acceptDropInCharge: input.acceptDropInCharge ?? false,
        },
        branchId,
      });
    },
    onSuccess: (r) => {
      bookAttempt.retire();
      setActionError(null);
      setPendingCharge(null);
      setNotice(r.replayed ? 'That member already had a seat.' : 'Seat booked.');
      setBookMemberId('');
      refresh();
    },
    onError: (err, input) => {
      // This class needs a credit the member does not have — offer the same
      // explicit-consent drop-in charge the member's own booking would show,
      // rather than dead-ending on a generic error.
      if (err instanceof ApiError && err.code === 'PAYMENT_REQUIRED') {
        setPendingCharge({
          memberId: input.memberId,
          dropInPriceMinor: (err.details?.dropInPriceMinor as number | undefined) ?? null,
        });
        return;
      }
      fail(err);
    },
  });

  const overrideAttempt = useIdempotentAttempt('admin-book-override');
  const bookMemberOverride = useMutation({
    mutationFn: (input: { sessionId: string; memberId: string; reason: string }) => {
      const identity = { sessionId: input.sessionId, memberId: input.memberId, reason: input.reason };
      return api<{ replayed: boolean }>(`/admin/schedule/session/${input.sessionId}/book-override`, {
        method: 'POST',
        body: {
          memberId: input.memberId,
          idempotencyKey: overrideAttempt.keyFor(identity),
          reason: input.reason,
        },
        branchId,
      });
    },
    onSuccess: (r) => {
      overrideAttempt.retire();
      setActionError(null);
      setNotice(r.replayed ? 'That member already had a seat.' : 'Seat booked as an override.');
      setBookMemberId('');
      setOverrideReason('');
      setBookOverride(false);
      refresh();
    },
    onError: fail,
  });

  const release = useMutation({
    mutationFn: (bookingId: string) =>
      api<{ state: string; creditsReturned: number; promoted: { memberId: string } | null }>(
        `/admin/schedule/booking/${bookingId}/release`,
        { method: 'POST', body: { reason: null }, branchId },
      ),
    onSuccess: (r) => {
      setActionError(null);
      setNotice(
        r.promoted
          ? 'Seat released and offered to the next person waiting.'
          : `Seat released${r.creditsReturned > 0 ? ', credit returned' : ''}.`,
      );
      refresh();
    },
    onError: fail,
  });

  const mark = useMutation({
    mutationFn: (input: { bookingId: string; state: 'attended' | 'no_show' | 'confirmed' }) =>
      api(`/admin/schedule/booking/${input.bookingId}/attendance`, {
        method: 'POST',
        body: { state: input.state },
        branchId,
      }),
    onSuccess: () => {
      setActionError(null);
      refresh();
    },
    onError: fail,
  });

  if (!canView) {
    return (
      <Page title="Schedule">
        <PermissionState what="The class schedule" />
      </Page>
    );
  }

  if (day.isLoading) {
    return (
      <Page title="Schedule" kicker="Loading">
        <div className="flex flex-col gap-3 p-4">
          <Skeleton className="h-12" />
          <Skeleton className="h-20" />
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      </Page>
    );
  }

  if (day.error || !day.data) {
    return (
      <Page title="Schedule">
        <ErrorState
          title="Could not load the timetable"
          body="The API did not answer. No class has been changed."
          onRetry={() => void day.refetch()}
          requestId={day.error instanceof ApiError ? day.error.requestId : undefined}
        />
      </Page>
    );
  }

  const { totals, items } = day.data;
  const fill = totals.seats > 0 ? Math.round((totals.booked / totals.seats) * 100) : 0;

  return (
    <Page title="Schedule" kicker={`${branchName} · ${day.data.dateLabel}`}>
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

      {/* — The week strip ————————————————————————————————————— */}

      <Toolbar>
        {day.data.days.map((d) => (
          <button
            key={d.date}
            type="button"
            onClick={() => {
              setDate(d.date);
              setOpenSession(null);
            }}
            aria-pressed={d.date === day.data.date}
            className={cx(
              'flex min-h-11 flex-col items-center justify-center border px-3 transition-colors',
              d.date === day.data.date
                ? 'border-sonar bg-wash-sonar text-sonar'
                : 'border-line-strong text-foam-50 hover:border-sonar hover:text-sonar',
            )}
          >
            <span className="font-utility text-[9px] uppercase tracking-[0.14em]">{d.weekday}</span>
            <span className="font-display text-[15px] leading-none">{d.dayNo}</span>
          </button>
        ))}
      </Toolbar>

      {/* — The day at a glance ————————————————————————————————— */}

      <Panel className="border-b border-line">
        <div className="flex flex-wrap items-end gap-8 p-3.5">
          <div>
            <Label>Classes</Label>
            <div className="mt-1">
              <Metric value={totals.sessions} size="lg" />
            </div>
          </div>
          <div>
            <Label>Seats filled</Label>
            <div className="mt-1 flex items-baseline gap-2">
              <Metric value={totals.booked} size="md" tone={FILL_TONE(fill) === 'bad' ? 'bad' : 'accent'} />
              <span className="text-[13px] text-foam-45">of {totals.seats}</span>
            </div>
          </div>
          <div className="min-w-[180px] flex-1">
            <Label>Utilisation</Label>
            <div className="mt-2">
              <Bar value={fill} max={100} tone={FILL_TONE(fill)} />
            </div>
          </div>
          {totals.waitlisted > 0 ? (
            <div>
              <Label>Waiting</Label>
              <div className="mt-1">
                <Metric value={totals.waitlisted} size="md" tone="warn" />
              </div>
            </div>
          ) : null}
          {totals.cancelled > 0 ? <Chip tone="bad">{totals.cancelled} cancelled</Chip> : null}
        </div>
      </Panel>

      {/* — The timetable ——————————————————————————————————————— */}

      {items.length === 0 ? (
        <EmptyState
          title="No classes on this day"
          body="Pick another day in the strip above, or add a class to the timetable."
        />
      ) : (
        <ul className="flex flex-col">
          {items.map((session) => {
            const open = openSession === session.id;
            const cancelled = session.state === 'cancelled';
            return (
              <li key={session.id} className="border-b border-line">
                <button
                  type="button"
                  onClick={() => setOpenSession(open ? null : session.id)}
                  aria-expanded={open}
                  className={cx(
                    'flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-wash-sonar-soft',
                    cancelled && 'opacity-60',
                  )}
                >
                  <div className="w-20 flex-none">
                    <div className="font-display text-[15px] leading-none tabular-nums">{session.localTime}</div>
                    <div className="mt-1 font-utility text-[9px] uppercase tracking-[0.12em] text-foam-35">
                      {session.durationMin} min
                    </div>
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px]">{session.name}</div>
                    <div className="truncate font-utility text-[10px] uppercase tracking-[0.12em] text-foam-35">
                      {session.trainerName} · {session.roomName}
                      {day.data.items.some((i) => i.branchId !== session.branchId) ? ` · ${session.branchName}` : ''}
                    </div>
                    {cancelled && session.cancelledReason ? (
                      <div className="mt-1 text-[11px] leading-relaxed text-chum">{session.cancelledReason}</div>
                    ) : null}
                  </div>

                  {session.substituted ? <Chip tone="warn">Cover</Chip> : null}
                  {session.waitlistCount > 0 ? <Chip tone="warn">{session.waitlistCount} waiting</Chip> : null}
                  {cancelled ? <Chip tone="bad">Cancelled</Chip> : null}

                  <div className="w-28 flex-none">
                    <div className="flex items-baseline justify-end gap-1">
                      <span className="font-display text-[15px] tabular-nums">{session.booked}</span>
                      <span className="text-[11px] text-foam-35">/ {session.capacity}</span>
                    </div>
                    <div className="mt-1.5">
                      <Bar value={session.booked} max={Math.max(1, session.capacity)} tone={FILL_TONE(session.fillPct)} />
                    </div>
                  </div>
                </button>

                {open ? (
                  <div className="border-t border-line bg-hull">
                    {detail.isLoading ? (
                      <div className="flex flex-col gap-2 p-3.5">
                        <Skeleton className="h-10" />
                        <Skeleton className="h-24" />
                      </div>
                    ) : detail.error || !detail.data ? (
                      <ErrorState
                        title="Could not load the roster"
                        body="The class above is unchanged."
                        onRetry={() => void detail.refetch()}
                      />
                    ) : (
                      <SessionDetail
                        data={detail.data}
                        canManage={canManage}
                        canBookOthers={canBookOthers}
                        canOverrideBooking={canOverrideBooking}
                        canMarkAttendance={canMarkAttendance}
                        trainers={resources.data?.trainers ?? []}
                        bookMemberId={bookMemberId}
                        setBookMemberId={setBookMemberId}
                        bookOverride={bookOverride}
                        setBookOverride={setBookOverride}
                        overrideReason={overrideReason}
                        setOverrideReason={setOverrideReason}
                        pendingCharge={pendingCharge}
                        onCancel={(reason, scope) => cancelSession.mutate({ sessionId: session.id, reason, scope })}
                        onSubstitute={(trainerId) => substitute.mutate({ sessionId: session.id, trainerId })}
                        onBook={(memberId) => bookMember.mutate({ sessionId: session.id, memberId })}
                        onBookOverride={(memberId, reason) => bookMemberOverride.mutate({ sessionId: session.id, memberId, reason })}
                        onConfirmCharge={(memberId) => bookMember.mutate({ sessionId: session.id, memberId, acceptDropInCharge: true })}
                        onCancelCharge={() => setPendingCharge(null)}
                        onRelease={(bookingId) => release.mutate(bookingId)}
                        onMark={(bookingId, state) => mark.mutate({ bookingId, state })}
                        busy={
                          cancelSession.isPending ||
                          substitute.isPending ||
                          bookMember.isPending ||
                          bookMemberOverride.isPending ||
                          release.isPending
                        }
                      />
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Page>
  );
}

/** The roster. Everything the console can do to a class lives here, next to the
 *  people it would affect. */
function SessionDetail({
  data,
  canManage,
  canBookOthers,
  canOverrideBooking,
  canMarkAttendance,
  trainers,
  bookMemberId,
  setBookMemberId,
  bookOverride,
  setBookOverride,
  overrideReason,
  setOverrideReason,
  pendingCharge,
  onCancel,
  onSubstitute,
  onBook,
  onBookOverride,
  onConfirmCharge,
  onCancelCharge,
  onRelease,
  onMark,
  busy,
}: {
  data: DetailPayload;
  canManage: boolean;
  canBookOthers: boolean;
  canOverrideBooking: boolean;
  canMarkAttendance: boolean;
  trainers: Array<{ id: string; name: string }>;
  bookMemberId: string;
  setBookMemberId: (value: string) => void;
  bookOverride: boolean;
  setBookOverride: (value: boolean) => void;
  overrideReason: string;
  setOverrideReason: (value: string) => void;
  pendingCharge: { memberId: string; dropInPriceMinor: number | null } | null;
  onCancel: (reason: string, scope: 'occurrence' | 'series') => void;
  onSubstitute: (trainerId: string) => void;
  onBook: (memberId: string) => void;
  onBookOverride: (memberId: string, reason: string) => void;
  onConfirmCharge: (memberId: string) => void;
  onCancelCharge: () => void;
  onRelease: (bookingId: string) => void;
  onMark: (bookingId: string, state: 'attended' | 'no_show' | 'confirmed') => void;
  busy: boolean;
}) {
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [scope, setScope] = useState<'occurrence' | 'series'>('occurrence');
  const { session, counts, roster, waitlist } = data;
  const live = roster.filter((r) => r.state !== 'cancelled' && r.state !== 'late_cancelled');
  const cancelled = session.state === 'cancelled';

  return (
    <div className="flex flex-col gap-4 p-3.5">
      <div className="flex flex-wrap items-center gap-4">
        <span className="font-utility text-[10px] uppercase tracking-[0.12em] text-foam-45">
          {counts.live} booked · {counts.waitlisted} waiting
          {counts.attended > 0 ? ` · ${counts.attended} attended` : ''}
          {counts.noShow > 0 ? ` · ${counts.noShow} no-show` : ''}
        </span>
        <span className="flex-1" />

        {canManage && !cancelled ? (
          <>
            {trainers.length > 0 ? (
              <label className="flex items-center gap-2">
                <span className="font-utility text-[9px] uppercase tracking-[0.14em] text-foam-35">Cover</span>
                <select
                  aria-label="Assign a covering trainer"
                  className="min-h-9 border border-line bg-panel px-2 font-utility text-[11px] uppercase tracking-[0.1em] text-foam"
                  value={session.trainerId ?? ''}
                  onChange={(e) => {
                    if (e.target.value && e.target.value !== session.trainerId) onSubstitute(e.target.value);
                  }}
                  disabled={busy}
                >
                  <option value="">Unassigned</option>
                  {trainers.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <Button variant="danger" disabled={busy} onClick={() => setCancelling((v) => !v)}>
              {cancelling ? 'Keep class' : 'Cancel class'}
            </Button>
          </>
        ) : null}
      </div>

      {/* Cancelling a class is destructive and touches money, so it states its
          own blast radius before it is confirmed (UX-A09 acceptance). */}
      {cancelling && !cancelled ? (
        <div className="flex flex-col gap-2 border border-chum bg-wash-chum p-3">
          <Eyebrow>Cancel this class</Eyebrow>
          <p className="max-w-[68ch] text-[12px] leading-relaxed text-foam-65">
            {counts.live} {counts.live === 1 ? 'person is' : 'people are'} booked in
            {counts.waitlisted > 0 ? ` and ${counts.waitlisted} waiting` : ''}. Everyone is told, seats are released and
            any class credit is returned — the cancellation deadline does not apply, because the gym is cancelling.
          </p>
          <Field
            label="Reason (members see this)"
            placeholder="Studio floor being resurfaced"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="max-w-[460px]"
          />
          {session.seriesId ? (
            <div className="flex items-center gap-2">
              {(['occurrence', 'series'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setScope(value)}
                  aria-pressed={scope === value}
                  className={cx(
                    'min-h-9 border px-2.5 font-utility text-[10px] font-semibold uppercase tracking-[0.12em]',
                    scope === value ? 'border-sonar bg-wash-sonar text-sonar' : 'border-line-strong text-foam-50',
                  )}
                >
                  {value === 'occurrence' ? 'This class only' : 'This and future in the series'}
                </button>
              ))}
            </div>
          ) : null}
          <div className="flex items-center gap-2">
            <Button
              variant="danger"
              disabled={busy || reason.trim().length < 4}
              onClick={() => {
                onCancel(reason.trim(), scope);
                setCancelling(false);
                setReason('');
              }}
            >
              Cancel {scope === 'series' ? 'the series' : 'this class'}
            </Button>
            <Button variant="ghost" onClick={() => setCancelling(false)}>
              Keep it
            </Button>
          </div>
        </div>
      ) : null}

      {/* — Roster ——————————————————————————————————————————— */}

      <div>
        <Label>Roster</Label>
        {live.length === 0 ? (
          <p className="mt-2 text-[12px] text-foam-45">
            Nobody is booked in yet.{canBookOthers && !cancelled ? ' Add someone below.' : ''}
          </p>
        ) : (
          <ul className="mt-2 flex flex-col border border-line">
            {live.map((row) => (
              <li key={row.bookingId} className="flex items-center gap-3 border-b border-line-10 px-3 py-2 last:border-b-0">
                <span className="grid h-7 w-7 flex-none place-items-center border border-line-strong font-utility text-[10px] font-semibold">
                  {row.initials}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px]">{row.name}</div>
                  <div className="font-utility text-[10px] uppercase tracking-[0.12em] text-foam-35">
                    {row.memberNo}
                    {row.seatNo ? ` · seat ${row.seatNo}` : ''}
                    {row.cameFromWaitlist ? ' · from waitlist' : ''}
                  </div>
                </div>

                <Chip tone={ROSTER_TONE[row.state] ?? 'neutral'}>{row.state.replace(/_/g, ' ')}</Chip>

                {canMarkAttendance && !cancelled && session.started ? (
                  <div className="flex items-center gap-1.5">
                    <Button
                      variant={row.state === 'attended' ? 'cta' : 'outline'}
                      onClick={() => onMark(row.bookingId, row.state === 'attended' ? 'confirmed' : 'attended')}
                      aria-label={`Mark ${row.name} as attended`}
                    >
                      Here
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => onMark(row.bookingId, row.state === 'no_show' ? 'confirmed' : 'no_show')}
                      aria-label={`Mark ${row.name} as a no-show`}
                    >
                      No-show
                    </Button>
                  </div>
                ) : null}

                {canBookOthers && !cancelled ? (
                  <Button variant="ghost" disabled={busy} onClick={() => onRelease(row.bookingId)}>
                    Release
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {canBookOthers && !cancelled && session.seatsLeft > 0 ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-end gap-2">
            <Field
              label="Book a member on"
              placeholder="Member ID"
              hint={`${session.seatsLeft} ${session.seatsLeft === 1 ? 'seat' : 'seats'} left`}
              value={bookMemberId}
              onChange={(e) => setBookMemberId(e.target.value)}
              className="max-w-[320px]"
            />
            <Button
              variant={bookOverride ? 'danger' : 'cta'}
              disabled={busy || bookMemberId.trim().length < 3 || (bookOverride && overrideReason.trim().length < 4)}
              onClick={() =>
                bookOverride
                  ? onBookOverride(bookMemberId.trim(), overrideReason.trim())
                  : onBook(bookMemberId.trim())
              }
            >
              {bookOverride ? 'Book seat (override)' : 'Book seat'}
            </Button>
          </div>

          {canOverrideBooking ? (
            <label className="flex items-center gap-2 text-[12px] text-foam-45">
              <input type="checkbox" checked={bookOverride} onChange={(e) => setBookOverride(e.target.checked)} />
              Override eligibility — bypass membership, credits and booking-window checks. Requires a reason and is
              always audited.
            </label>
          ) : null}

          {bookOverride ? (
            <Field
              label="Override reason"
              placeholder="Why this member is being booked without meeting the usual checks"
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              className="max-w-[420px]"
            />
          ) : null}

          {pendingCharge ? (
            <div className="flex items-center gap-2 border border-line-strong px-3 py-2 text-[12px]">
              <span>
                This class needs a class credit the member does not have.
                {pendingCharge.dropInPriceMinor
                  ? ` A drop-in charge of ₹${(pendingCharge.dropInPriceMinor / 100).toLocaleString('en-IN')} applies.`
                  : ''}{' '}
                Confirm the member will pay?
              </span>
              <Button variant="cta" disabled={busy} onClick={() => onConfirmCharge(pendingCharge.memberId)}>
                Confirm charge
              </Button>
              <Button variant="ghost" onClick={onCancelCharge}>
                Cancel
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* — Waitlist ————————————————————————————————————————— */}

      {waitlist.length > 0 ? (
        <div>
          <Label>Waiting · in order</Label>
          <ul className="mt-2 flex flex-col border border-line">
            {waitlist.map((row) => (
              <li key={row.waitlistId} className="flex items-center gap-3 border-b border-line-10 px-3 py-2 last:border-b-0">
                <span className="w-6 flex-none font-display text-[14px] tabular-nums text-foam-45">{row.position}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px]">{row.name}</div>
                  <div className="font-utility text-[10px] uppercase tracking-[0.12em] text-foam-35">{row.memberNo}</div>
                </div>
                {row.state === 'offered' ? (
                  <Chip tone="warn">
                    Offered
                    {row.offerExpiresAt
                      ? ` · expires ${new Date(row.offerExpiresAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
                      : ''}
                  </Chip>
                ) : (
                  <Chip tone="neutral">Waiting</Chip>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 max-w-[68ch] text-[11px] leading-relaxed text-foam-35">
            Releasing a seat offers it to the top of this list automatically. Eligibility is re-checked at that moment,
            so anyone whose membership has lapsed is skipped rather than promoted into a booking that cannot work.
          </p>
        </div>
      ) : null}
    </div>
  );
}
