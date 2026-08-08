import type { ReactElement } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useCopy } from '../lib/store';
import { Hero, ScreenBody, Stack, Surface } from '../ui/shell';
import {
  Bar,
  Button,
  Chip,
  Display,
  Eyebrow,
  Label,
  Metric,
  Panel,
  Seam,
  SeamCell,
  SectionRule,
  Skeleton,
  ErrorState,
} from '../ui/primitives';

interface HomePayload {
  member: { firstName: string; initials: string; memberNo: string };
  branch: { id: string; name: string; timezone: string };
  today: { date: string; label: string };
  order: string[];
  membership: {
    id: string;
    productName: string;
    state: string;
    endsOn: string | null;
    autoRenew: boolean;
    allBranches: boolean;
    entitled: boolean;
  } | null;
  membershipIssue: {
    severity: 'blocking' | 'warning';
    title: string;
    body: string;
    action: { label: string; to: string };
  } | null;
  outstanding: { totalMinor: number; invoiceCount: number };
  training: {
    state: 'ready' | 'in_progress' | 'done' | 'rest' | 'no_program';
    programDayId: string | null;
    assignmentId: string | null;
    title: string;
    blockLabel: string;
    exerciseCount: number;
    setCount: number;
    estimatedMin: number;
    coachName: string | null;
    completedSets: number;
  };
  nextBooking: {
    bookingId: string;
    sessionId: string;
    name: string;
    roomName: string;
    trainerName: string;
    localTime: string;
    isToday: boolean;
    seatNo: number | null;
    capacity: number;
    cancelled: boolean;
    cancelledReason: string | null;
    startsInMin: number;
  } | null;
  occupancy: { inside: number; capacity: number; label: string; pct: number };
  streak: {
    current: number;
    thisWeek: number;
    weeklyTarget: number;
    week: boolean[];
    atRisk: boolean;
  };
  level: { level: number; name: string; progressPct: number; xpIntoLevel: number; xpForNextLevel: number; nextName: string | null };
  monthVolumeKg: number;
  coachMessage: { body: string; senderName: string; relativeTime: string; conversationId: string; unread: boolean } | null;
  adaptive: { id: string; headline: string; explanation: string; reviewedByName: string | null; rulesVersion: string } | null;
  challenge: { id: string; name: string; daysLeft: number; rank: number; score: number; metricLabel: string } | null;
}

const rupees = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN')}`;

export default function HomeScreen() {
  const copy = useCopy();
  const navigate = useNavigate();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['home'],
    queryFn: () => api<HomePayload>('/member/home'),
  });

  if (isLoading) return <HomeSkeleton />;

  if (error || !data) {
    return (
      <ScreenBody>
        <Stack>
          <ErrorState
            title="Could not load your day"
            body="The gym's systems did not answer. Your workout data is safe on this phone."
            onRetry={() => void refetch()}
          />
        </Stack>
      </ScreenBody>
    );
  }

  const { training, streak, level } = data;

  const cards: Record<string, ReactElement | null> = {
    membership_issue: data.membershipIssue ? (
      // Money and access always speak plainly — never the predator register.
      <Panel
        key="issue"
        tone={data.membershipIssue.severity === 'blocking' ? 'bad' : 'warn'}
        className="flex flex-col gap-2.5 p-3.5"
      >
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={data.membershipIssue.severity === 'blocking' ? 'text-chum' : 'text-flare'}
          >
            {data.membershipIssue.severity === 'blocking' ? '×' : '!'}
          </span>
          <span className="font-utility text-[11px] font-semibold uppercase tracking-[0.16em]">
            {data.membershipIssue.title}
          </span>
        </div>
        <p className="text-[13px] leading-relaxed text-foam-80">{data.membershipIssue.body}</p>
        {data.outstanding.totalMinor > 0 ? (
          <p className="font-display text-[22px] leading-none">{rupees(data.outstanding.totalMinor)}</p>
        ) : null}
        <Link to={data.membershipIssue.action.to}>
          <Button variant="cta" size="sm">
            {data.membershipIssue.action.label}
          </Button>
        </Link>
      </Panel>
    ) : null,

    training: (
      <Panel
        key="training"
        className="bg-gradient-to-br from-wash-sonar to-transparent"
        tone={training.state === 'rest' ? 'plain' : 'accent'}
      >
        <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
          <Eyebrow>{training.state === 'rest' ? 'Rest day' : "Today's set"}</Eyebrow>
          <span className="flex-1" />
          <span className="text-[11px] tracking-[0.04em] text-foam-50">{training.blockLabel}</span>
        </div>

        <div className="px-3.5 pb-3.5 pt-3.5">
          <Display size="md" as="h2">
            {training.title}
          </Display>

          {training.state === 'rest' ? (
            <p className="mt-2.5 text-[13px] leading-relaxed text-foam-65">
              Nothing scheduled. Rest is part of the plan — come in for mobility if you want to move.
            </p>
          ) : training.state === 'no_program' ? (
            <>
              <p className="mt-2.5 text-[13px] leading-relaxed text-foam-65">
                No coach has assigned you a plan yet. You can still log a session from the exercise library.
              </p>
              <Button className="mt-3.5" variant="outline" size="sm" onClick={() => void navigate({ to: '/train' })}>
                Browse exercises
              </Button>
            </>
          ) : (
            <>
              <div className="mt-2 flex gap-4 text-[12px] tracking-[0.03em] text-foam-65">
                <span>{training.exerciseCount} exercises</span>
                <span>~{training.estimatedMin} min</span>
                {training.coachName ? <span>{training.coachName}</span> : null}
              </div>

              {training.state === 'in_progress' && training.setCount > 0 ? (
                <Bar
                  className="mt-3"
                  value={training.completedSets}
                  max={training.setCount}
                  height="h-1.5"
                />
              ) : null}

              <div className="mt-3.5 flex gap-2.5">
                <Button
                  variant="cta"
                  className="flex-1"
                  disabled={training.state === 'done'}
                  onClick={() => void navigate({ to: '/workout' })}
                >
                  {training.state === 'done'
                    ? 'Logged today'
                    : training.state === 'in_progress'
                      ? copy('resumeSession')
                      : copy('startSession')}
                </Button>
                <Button variant="outline" className="w-[110px]" onClick={() => void navigate({ to: '/train' })}>
                  Plan
                </Button>
              </div>
            </>
          )}
        </div>
      </Panel>
    ),

    adaptive: data.adaptive ? (
      <Panel key="adaptive" tone="warn" className="p-3.5">
        <Label className="text-flare">Your plan changed</Label>
        <p className="mt-1.5 font-utility text-[15px] font-semibold">{data.adaptive.headline}</p>
        <p className="mt-1.5 text-[13px] leading-relaxed text-foam-65">{data.adaptive.explanation}</p>
        <p className="mt-2 border-t border-line pt-2 text-[11px] leading-relaxed text-foam-45">
          Rules {data.adaptive.rulesVersion}
          {data.adaptive.reviewedByName ? ` · reviewed by ${data.adaptive.reviewedByName}` : ''}. Estimates only —
          tell your coach if anything hurts.
        </p>
        <Button className="mt-3" variant="outline" size="sm" onClick={() => void navigate({ to: '/train' })}>
          See the change
        </Button>
      </Panel>
    ) : null,

    next_booking: data.nextBooking ? (
      <Panel key="booking" tone={data.nextBooking.cancelled ? 'bad' : 'plain'} className="flex items-center gap-3 p-3.5">
        <div className="border-r border-line pr-3 text-center">
          <Metric value={data.nextBooking.localTime} size="sm" />
          <Label className="mt-1 block">{data.nextBooking.isToday ? 'Today' : 'Next'}</Label>
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-utility text-[16px] font-semibold">{data.nextBooking.name}</p>
          <p className="mt-0.5 truncate text-[12px] text-foam-50">
            {data.nextBooking.cancelled
              ? (data.nextBooking.cancelledReason ?? 'This class was cancelled.')
              : `${data.nextBooking.trainerName} · ${data.nextBooking.roomName} · seat ${data.nextBooking.seatNo ?? '—'} of ${data.nextBooking.capacity}`}
          </p>
        </div>
        <Link to="/book" aria-label="Open your bookings" className="grid h-9 w-9 flex-none place-items-center border border-line-strong hover:border-sonar hover:text-sonar">
          <span aria-hidden="true">›</span>
        </Link>
      </Panel>
    ) : null,

    stats: (
      <Seam key="stats">
        <SeamCell>
          <Label>{copy('streakLabel')}</Label>
          <div className="mt-1.5 flex items-baseline gap-1.5">
            <Metric value={streak.current} size="md" />
            <span className="text-[11px] text-foam-45">days</span>
          </div>
          <div className="mt-2 flex gap-1" aria-hidden="true">
            {streak.week.map((done, i) => (
              <span
                key={i}
                className={`h-3 flex-1 border ${done ? 'border-sonar bg-sonar' : 'border-line'}`}
              />
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-foam-50">
            {streak.thisWeek} of {streak.weeklyTarget} this week
          </p>
        </SeamCell>
        <SeamCell>
          <Label>Apex tier</Label>
          <div className="mt-1.5 flex items-baseline gap-1.5">
            <Metric value={level.level} size="md" tone="accent" />
            <span className="text-[12px] text-sonar">{level.name}</span>
          </div>
          <Bar className="mt-2.5" value={level.progressPct} height="h-[3px]" />
          <p className="mt-1.5 text-[11px] text-foam-50">
            {level.nextName
              ? `${level.xpIntoLevel.toLocaleString('en-IN')} / ${level.xpForNextLevel.toLocaleString('en-IN')} to ${level.nextName}`
              : 'Top tier reached'}
          </p>
        </SeamCell>
      </Seam>
    ),

    coach: data.coachMessage ? (
      <Link key="coach" to="/messages/$conversationId" params={{ conversationId: data.coachMessage.conversationId }}>
        <Panel className="flex items-start gap-3 p-3.5 hover:border-line-strong">
          <span className="grid h-9 w-9 flex-none place-items-center border border-line-strong font-utility text-[12px] font-semibold">
            {data.coachMessage.senderName
              .split(' ')
              .map((p) => p[0])
              .join('')
              .slice(0, 2)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[12px] text-foam-50">
              {data.coachMessage.senderName} · coach · {data.coachMessage.relativeTime}
            </p>
            <p className="mt-1 text-[14px] leading-relaxed text-pretty">{data.coachMessage.body}</p>
          </div>
        </Panel>
      </Link>
    ) : null,

    occupancy: (
      <Panel key="occupancy" className="p-3.5">
        <div className="flex items-baseline gap-2">
          <Label>Floor occupancy</Label>
          <span className="flex-1" />
          <Chip tone={data.occupancy.label === 'peak' ? 'warn' : 'accent'} glyph={false}>
            {data.occupancy.label}
          </Chip>
        </div>
        <div className="mt-2 flex items-end gap-1.5">
          <Metric value={data.occupancy.inside} size="lg" />
          <span className="pb-1 text-[12px] text-foam-50">/ {data.occupancy.capacity} now</span>
        </div>
        <Bar className="mt-2.5" value={data.occupancy.pct} height="h-2.5" ticks />
        <div className="mt-1.5 flex justify-between font-utility text-[9px] tracking-[0.1em] text-foam-35">
          <span>QUIET</span>
          <span>PEAK 7PM</span>
        </div>
      </Panel>
    ),

    challenge: data.challenge ? (
      <Link key="challenge" to="/pack/challenge/$challengeId" params={{ challengeId: data.challenge.id }}>
        <Panel className="p-3.5 hover:border-line-strong">
          <div className="flex items-center gap-2">
            <Eyebrow>{data.challenge.name}</Eyebrow>
            <span className="flex-1" />
            <span className="text-[11px] text-foam-50">{data.challenge.daysLeft} days left</span>
          </div>
          <div className="mt-2.5 flex items-center gap-3">
            <Metric value={`#${data.challenge.rank}`} size="md" tone="accent" />
            <p className="flex-1 text-[12px] leading-relaxed text-foam-50">
              Ranked on {data.challenge.metricLabel} attended. Volume lifted is never ranked.
            </p>
          </div>
        </Panel>
      </Link>
    ) : null,
  };

  return (
    <ScreenBody>
      <Surface>
        <Hero
          kicker={copy('homeKicker')}
          stats={
            <Seam className="mt-3 bg-abyss/50">
              <SeamCell className="px-3 py-2.5">
                <Metric value={streak.current} size="md" />
                <Label className="mt-0.5 block">{copy('streakLabel')}</Label>
              </SeamCell>
              <SeamCell className="px-3 py-2.5">
                <Metric value={(data.monthVolumeKg / 1000).toFixed(1)} unit="t" size="md" />
                <Label className="mt-0.5 block">Volume / mo</Label>
              </SeamCell>
              <SeamCell className="px-3 py-2.5">
                <Metric value={`A${level.level}`} size="md" tone="accent" />
                <Label className="mt-0.5 block">Apex tier</Label>
              </SeamCell>
            </Seam>
          }
        >
          <Display size="xl" className="mt-2">
            {copy('homeHeroA')}
            <br />
            <span className="text-sonar">{copy('homeHeroB')}</span>
          </Display>
        </Hero>

        <Stack>
          {data.order.map((key) => cards[key]).filter(Boolean)}

          <SectionRule>Quick actions</SectionRule>
          <div className="grid grid-cols-2 gap-2.5">
            <Link to="/pass">
              <Button variant="outline" full>
                Entry code
              </Button>
            </Link>
            <Link to="/book">
              <Button variant="outline" full>
                Book a class
              </Button>
            </Link>
            <Link to="/habits">
              <Button variant="outline" full>
                Daily habits
              </Button>
            </Link>
            <Link to="/messages">
              <Button variant="outline" full>
                Message coach
              </Button>
            </Link>
          </div>
        </Stack>
      </Surface>
    </ScreenBody>
  );
}

function HomeSkeleton() {
  return (
    <ScreenBody>
      <div className="border-b border-line px-4 pb-5 pt-6">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="mt-3 h-11 w-56" />
        <Skeleton className="mt-3 h-16 w-full" />
      </div>
      <Stack>
        <Skeleton className="h-44 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-28 w-full" />
      </Stack>
    </ScreenBody>
  );
}
