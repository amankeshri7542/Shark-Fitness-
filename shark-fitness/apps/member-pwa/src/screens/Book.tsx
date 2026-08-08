import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, idempotencyKey } from '../lib/api';
import { ApiError } from '../lib/api';
import { ScreenBody, Stack, Surface } from '../ui/shell';
import {
  Button,
  Chip,
  Display,
  EmptyState,
  ErrorState,
  Label,
  Metric,
  Panel,
  Seam,
  SeamCell,
  Skeleton,
  cx,
} from '../ui/primitives';

interface Eligibility {
  canBook: boolean;
  action: 'book' | 'waitlist' | 'cancel' | 'pay' | 'blocked' | 'closed';
  reason: string;
  creditsRequired: number;
  creditsHeld: number;
  dropInPriceMinor: number | null;
  cancelDeadlineAt: string | null;
}

interface Session {
  id: string;
  name: string;
  category: string;
  intensity: string;
  description: string;
  trainerName: string;
  roomName: string;
  branchName: string;
  localTime: string;
  localEndTime: string;
  durationMin: number;
  capacity: number;
  booked: number;
  seatsLeft: number;
  waitlistCount: number;
  state: string;
  cancelledReason: string | null;
  substituteFor: string | null;
  myBooking: { id: string; state: string; seatNo: number | null } | null;
  myWaitlist: { id: string; position: number; state: string; offerExpiresAt: string | null } | null;
  eligibility: Eligibility;
}

interface SchedulePayload {
  branch: { id: string; name: string };
  date: string;
  dateLabel: string;
  days: Array<{ date: string; weekday: string; dayNo: number; monthLabel: string; isToday: boolean; sessionCount: number }>;
  category: string;
  categories: Array<{ value: string; label: string; count: number }>;
  membership: { entitled: boolean; reason: string | null; productName: string };
  credits: { class: number };
  waitlist: { offerWindowMin: number };
  items: Session[];
}

const rupees = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN')}`;

export default function BookScreen() {
  const queryClient = useQueryClient();
  const [date, setDate] = useState<string | null>(null);
  const [category, setCategory] = useState('all');
  const [sheet, setSheet] = useState<Session | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const query = new URLSearchParams();
  if (date) query.set('date', date);
  if (category !== 'all') query.set('category', category);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['schedule', date, category],
    queryFn: () => api<SchedulePayload>(`/member/schedule${query.toString() ? `?${query}` : ''}`),
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['schedule'] });
    void queryClient.invalidateQueries({ queryKey: ['home'] });
  };

  /* A last-seat claim is never queued through the outbox — it has to wait for
     the server to say whether the seat was actually yours (Design PRD §"Feedback
     and status"). */
  const book = useMutation({
    mutationFn: (session: Session) =>
      api('/member/schedule/book', {
        method: 'POST',
        body: {
          sessionId: session.id,
          idempotencyKey: idempotencyKey('book', session.id),
          acceptDropInCharge: session.eligibility.action === 'pay',
        },
      }),
    onMutate: () => setActionError(null),
    onSuccess: refresh,
    onError: (e) => setActionError(e instanceof ApiError ? e.message : 'That did not go through. Try again.'),
  });

  const cancel = useMutation({
    mutationFn: (bookingId: string) => api(`/member/schedule/booking/${bookingId}`, { method: 'DELETE' }),
    onMutate: () => setActionError(null),
    onSuccess: refresh,
    onError: (e) => setActionError(e instanceof ApiError ? e.message : 'That did not go through. Try again.'),
  });

  const joinWaitlist = useMutation({
    mutationFn: (sessionId: string) =>
      api('/member/schedule/waitlist', { method: 'POST', body: { sessionId } }),
    onMutate: () => setActionError(null),
    onSuccess: () => {
      setSheet(null);
      refresh();
    },
    onError: (e) => setActionError(e instanceof ApiError ? e.message : 'That did not go through. Try again.'),
  });

  const leaveWaitlist = useMutation({
    mutationFn: (waitlistId: string) => api(`/member/schedule/waitlist/${waitlistId}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  if (isLoading) return <BookSkeleton />;

  if (error || !data) {
    return (
      <ScreenBody>
        <Stack>
          <ErrorState
            title="Could not load the timetable"
            body="Any bookings you already hold are unaffected."
            onRetry={() => void refetch()}
          />
        </Stack>
      </ScreenBody>
    );
  }

  const busy = book.isPending || cancel.isPending || joinWaitlist.isPending;

  return (
    <ScreenBody>
      <Surface>
        <Stack>
          <div className="flex items-baseline gap-3">
            <Display size="lg">Book</Display>
            <span className="flex-1" />
            <span className="font-utility text-[11px] uppercase tracking-[0.12em] text-foam-45">
              {data.credits.class} credit{data.credits.class === 1 ? '' : 's'}
            </span>
          </div>

          {!data.membership.entitled ? (
            <Panel tone="warn" className="p-3.5">
              <Label className="text-flare">Bookings paused</Label>
              <p className="mt-1.5 text-[13px] leading-relaxed text-foam-80">
                {data.membership.reason ?? 'Your membership does not cover bookings right now.'}
              </p>
            </Panel>
          ) : null}

          {/* Date strip */}
          <div className="-mx-4 overflow-x-auto px-4 sf-hide-scroll">
            <div className="flex min-w-max border border-line">
              {data.days.map((day, i) => {
                const active = day.date === data.date;
                return (
                  <button
                    key={day.date}
                    type="button"
                    onClick={() => setDate(day.date)}
                    aria-pressed={active}
                    className={cx(
                      'min-h-[58px] w-[58px] flex-none px-1 py-2 transition-colors',
                      i > 0 && 'border-l border-line',
                      active ? 'bg-sonar text-on-accent' : 'text-foam-65 hover:text-foam',
                    )}
                  >
                    <span className="block font-utility text-[10px] font-semibold uppercase tracking-[0.1em] opacity-70">
                      {day.weekday}
                    </span>
                    <span className="mt-0.5 block font-display text-[19px] leading-none">{day.dayNo}</span>
                    <span className="mt-1 block font-utility text-[9px] uppercase tracking-[0.08em] opacity-60">
                      {day.sessionCount}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <p className="-mt-1 font-utility text-[11px] uppercase tracking-[0.12em] text-foam-45">{data.dateLabel}</p>

          {/* Category filter */}
          <div className="-mx-4 overflow-x-auto px-4 sf-hide-scroll">
            <div className="flex min-w-max gap-1.5">
              {data.categories.map((cat) => (
                <button
                  key={cat.value}
                  type="button"
                  onClick={() => setCategory(cat.value)}
                  aria-pressed={cat.value === data.category}
                  className={cx(
                    'min-h-9 border px-3 font-utility text-[11px] font-semibold uppercase tracking-[0.1em] transition-colors',
                    cat.value === data.category
                      ? 'border-sonar text-sonar'
                      : 'border-line text-foam-50 hover:text-foam',
                  )}
                >
                  {cat.label} <span className="opacity-50">{cat.count}</span>
                </button>
              ))}
            </div>
          </div>

          {actionError ? (
            <Panel tone="bad" className="p-3">
              <p className="text-[13px] leading-relaxed text-foam-80">{actionError}</p>
            </Panel>
          ) : null}

          {data.items.length === 0 ? (
            <EmptyState
              title="Nothing on this day"
              body="No classes are scheduled here yet. Try another day, or clear the filter to see everything."
              action={
                category !== 'all' ? (
                  <Button variant="outline" size="sm" onClick={() => setCategory('all')}>
                    Clear filter
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="flex flex-col gap-2.5">
              {data.items.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  busy={busy}
                  onBook={() => book.mutate(session)}
                  onCancel={() => session.myBooking && cancel.mutate(session.myBooking.id)}
                  onWaitlist={() => setSheet(session)}
                  onLeaveWaitlist={() => session.myWaitlist && leaveWaitlist.mutate(session.myWaitlist.id)}
                />
              ))}
            </div>
          )}
        </Stack>
      </Surface>

      {sheet ? (
        <WaitlistSheet
          session={sheet}
          offerWindowMin={data.waitlist.offerWindowMin}
          busy={joinWaitlist.isPending}
          onConfirm={() => joinWaitlist.mutate(sheet.id)}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </ScreenBody>
  );
}

function SessionRow({ session, busy, onBook, onCancel, onWaitlist, onLeaveWaitlist }: {
  session: Session;
  busy: boolean;
  onBook: () => void;
  onCancel: () => void;
  onWaitlist: () => void;
  onLeaveWaitlist: () => void;
}) {
  const { eligibility: e } = session;
  const cancelled = session.state === 'cancelled';
  const mine = Boolean(session.myBooking && session.myBooking.state !== 'cancelled');

  return (
    <Panel
      tone={cancelled ? 'bad' : mine ? 'accent' : 'plain'}
      className={cx('p-3', e.action === 'blocked' && !cancelled && 'opacity-60')}
    >
      <div className="flex items-start gap-3">
        <div className="flex-none border-r border-line pr-3 text-center">
          <Metric value={session.localTime} size="sm" />
          <div className="mt-0.5 font-utility text-[10px] uppercase tracking-[0.08em] text-foam-35">
            {session.durationMin} min
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-utility text-[16px] font-semibold">{session.name}</span>
            {session.substituteFor ? (
              <Chip tone="warn" glyph={false}>
                Cover
              </Chip>
            ) : null}
          </div>
          <div className="mt-0.5 truncate text-[12px] text-foam-50">
            {session.trainerName} · {session.roomName}
            {session.seatsLeft > 0 && !cancelled ? ` · ${session.seatsLeft} left` : ''}
            {session.waitlistCount > 0 ? ` · ${session.waitlistCount} waiting` : ''}
          </div>

          {/* The server's own reason string is the copy. The button and its
              explanation can never disagree because both come from eligibility. */}
          <p
            className={cx(
              'mt-1.5 text-[11px] leading-snug',
              cancelled ? 'text-chum' : e.action === 'pay' ? 'text-flare' : mine ? 'text-sonar' : 'text-foam-45',
            )}
          >
            {cancelled ? (session.cancelledReason ?? 'This class was cancelled.') : e.reason}
          </p>
        </div>

        <div className="flex-none">
          {cancelled ? (
            <Chip tone="bad">Cancelled</Chip>
          ) : session.myWaitlist ? (
            <div className="flex flex-col items-end gap-1.5">
              <Chip tone="warn" glyph={false}>
                #{session.myWaitlist.position} waiting
              </Chip>
              <Button variant="ghost" size="sm" onClick={onLeaveWaitlist} disabled={busy}>
                Leave
              </Button>
            </div>
          ) : e.action === 'cancel' ? (
            <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          ) : e.action === 'waitlist' ? (
            <Button variant="outline" size="sm" onClick={onWaitlist} disabled={busy}>
              Waitlist
            </Button>
          ) : e.action === 'pay' ? (
            <Button variant="outline" size="sm" onClick={onBook} disabled={busy}>
              {e.dropInPriceMinor ? rupees(e.dropInPriceMinor) : 'Pay'}
            </Button>
          ) : e.action === 'book' ? (
            <Button variant="cta" size="sm" onClick={onBook} disabled={busy}>
              Book
            </Button>
          ) : (
            <Chip tone="neutral" glyph={false}>
              {e.action === 'closed' ? 'Closed' : 'Unavailable'}
            </Chip>
          )}
        </div>
      </div>
    </Panel>
  );
}

function WaitlistSheet({ session, offerWindowMin, busy, onConfirm, onClose }: {
  session: Session;
  offerWindowMin: number;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="absolute inset-0 z-30 flex items-end bg-scrim"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full border-t border-line-strong bg-overlay p-4 pb-6 animate-rise"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Join the waitlist"
      >
        <Display size="sm" as="h2">
          Join the waitlist?
        </Display>
        <p className="mt-2.5 text-[14px] leading-relaxed text-pretty text-foam-80">
          {session.name} · {session.localTime} · {session.trainerName}. You would be number{' '}
          {session.waitlistCount + 1} in line.
        </p>
        <Panel className="mt-3 p-3">
          <p className="text-[12px] leading-relaxed text-foam-50">
            No credit is taken now. If a seat opens you get {offerWindowMin} minutes to confirm before it passes to the
            next person.
          </p>
        </Panel>
        <div className="mt-3.5 flex gap-2.5">
          <Button variant="cta" size="lg" className="flex-1" onClick={onConfirm} disabled={busy}>
            {busy ? 'Joining…' : 'Join waitlist'}
          </Button>
          <Button variant="outline" size="lg" onClick={onClose}>
            Not now
          </Button>
        </div>
      </div>
    </div>
  );
}

function BookSkeleton() {
  return (
    <ScreenBody>
      <Stack>
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-[58px] w-full" />
        <Skeleton className="h-9 w-full" />
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-[92px] w-full" />
        ))}
      </Stack>
    </ScreenBody>
  );
}
