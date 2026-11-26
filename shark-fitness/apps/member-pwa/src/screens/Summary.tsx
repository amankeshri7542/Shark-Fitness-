import { useEffect, type ReactNode } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api';
import { useCopy } from '../lib/store';
import { haptic, useUnits, type Units } from '../lib/preferences';
import { readDoneSnapshot, type DoneSnapshot } from './Workout';
import { ScreenBody, Stack } from '../ui/shell';
import {
  Bar,
  Chip,
  Display,
  ErrorState,
  Label,
  Metric,
  Panel,
  Seam,
  SeamCell,
  SectionRule,
  Skeleton,
  cx,
} from '../ui/primitives';

/**
 * What just happened.
 *
 * A session is finished on the gym floor and synced through the outbox, so the
 * server may not have it yet. The local snapshot written when the workout ended
 * is the fallback: the member sees their numbers immediately, marked as not yet
 * synced, instead of a spinner or an error for a session they definitely did.
 *
 * Training copy uses the predator register. The volume warning does not — it is
 * a safety signal, and safety always speaks plainly.
 */

interface Summary {
  id: string;
  title: string;
  startedAt: string;
  finishedAt: string | null;
  durationSec: number;
  volumeKg: number;
  totalSets: number;
  completedSets: number;
  exerciseCount: number;
  xpAwarded: number;
  sessionRpe: number | null;
  notes: string | null;
  coachNote: string | null;
  personalRecords: Array<{ exerciseName: string; kind: string; value: number; label?: string }>;
  muscleVolume: Array<{ muscle: string; label: string; sets: number; share: number }>;
  /** The server sends the sentence itself (domain volumeWarning); the
   *  object form is accepted too. */
  volumeWarning: string | { level: string; message: string } | null;
  byExercise: Array<{
    exerciseId: string;
    exerciseName: string;
    sets: number;
    topSetKg: number;
    topSetReps: number;
    volumeKg: number;
    estimated1rm: number;
  }>;
}

/** Records measured in load (kg on the server). Reps and time are unitless here. */
function isLoadRecord(kind: string): boolean {
  return kind === 'weight' || kind === 'estimated_1rm';
}

function minutes(sec: number): string {
  const m = Math.floor(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

export default function SummaryScreen() {
  const { workoutId } = useParams({ from: '/bare/workout/summary/$workoutId' });
  const copy = useCopy('workout');
  const units = useUnits();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['workout-summary', workoutId],
    queryFn: () => api<{ summary: Summary }>(`/member/training/workouts/${workoutId}`),
    retry: false,
  });

  // Written locally the moment the session ended, before the outbox drained.
  const snapshot: DoneSnapshot | null = readDoneSnapshot(workoutId);

  // A personal record gets the one celebratory buzz, once per session.
  const prCount = data?.summary.personalRecords.length ?? 0;
  useEffect(() => {
    if (prCount === 0) return;
    const key = `shark.workout-pr-buzz:${workoutId}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
    } catch {
      /* buzz anyway */
    }
    haptic('personal-record');
  }, [prCount, workoutId]);

  if (isLoading && !snapshot) {
    return (
      <Frame share={null}>
        <Stack>
          <Skeleton className="h-28" />
          <Skeleton className="h-20" />
          <Skeleton className="h-40" />
        </Stack>
      </Frame>
    );
  }

  // The session is real even when the server has not caught up. Show the local
  // numbers and say plainly that they are still on their way.
  if ((error || !data) && snapshot) {
    return (
      <Frame share={shareText(snapshot.title, snapshot.volumeKg, snapshot.durationSec, units)}>
        <Stack>
          <Panel tone="warn" className="flex flex-col gap-1.5 p-4">
            <Label>Not synced yet</Label>
            <p className="text-[13px] leading-relaxed text-foam-65">
              These are the numbers from this device. The session is queued and uploads on its own — nothing is lost.
            </p>
          </Panel>

          <div>
            <Label>{new Date(snapshot.finishedAt).toLocaleDateString('en-GB')}</Label>
            <Display size="md" as="h1" className="mt-1">
              {snapshot.title}
            </Display>
          </div>

          <Seam>
            <SeamCell>
              <Label>Time</Label>
              <div className="mt-1">
                <Metric value={minutes(snapshot.durationSec)} size="md" />
              </div>
            </SeamCell>
            <SeamCell>
              <Label>Volume</Label>
              <div className="mt-1">
                <Metric value={units.value(snapshot.volumeKg, 0)} unit={units.unit} size="md" tone="accent" />
              </div>
            </SeamCell>
            <SeamCell>
              <Label>Sets</Label>
              <div className="mt-1">
                <Metric value={snapshot.completedSets} size="md" />
              </div>
            </SeamCell>
          </Seam>

          {snapshot.muscleVolume.length > 0 ? (
            <>
              <SectionRule>Where it landed</SectionRule>
              <Panel className="flex flex-col gap-2 p-4">
                {snapshot.muscleVolume.map((m) => (
                  <div key={m.muscle} className="flex items-center gap-2">
                    <span className="w-24 flex-none truncate text-[12px]">{m.label}</span>
                    <span className="flex-1">
                      <Bar value={m.share} max={100} tone="accent" />
                    </span>
                    <span className="w-8 flex-none text-right font-display text-[13px] tabular-nums">{m.sets}</span>
                  </div>
                ))}
              </Panel>
            </>
          ) : null}
        </Stack>
      </Frame>
    );
  }

  if (error || !data) {
    return (
      <Frame share={null}>
        <Stack>
          <ErrorState
            title="Could not load this session"
            body="If you just finished it, it may still be uploading. Open it again in a moment."
            onRetry={() => void refetch()}
            requestId={error instanceof ApiError ? error.requestId : undefined}
          />
        </Stack>
      </Frame>
    );
  }

  const s = data.summary;
  const volumeWarning =
    typeof s.volumeWarning === 'string' ? { level: 'warn', message: s.volumeWarning } : s.volumeWarning;

  return (
    <Frame share={shareText(s.title, s.volumeKg, s.durationSec, units)}>
      <Stack>
        <div>
          <Label>{s.finishedAt ? new Date(s.finishedAt).toLocaleDateString('en-GB') : 'In progress'}</Label>
          <Display size="md" as="h1" className="mt-1">
            {s.title}
          </Display>
        </div>

        <Seam>
          <SeamCell>
            <Label>Time</Label>
            <div className="mt-1">
              <Metric value={minutes(s.durationSec)} size="md" />
            </div>
          </SeamCell>
          <SeamCell>
            <Label>Volume</Label>
            <div className="mt-1">
              <Metric value={units.value(s.volumeKg, 0)} unit={units.unit} size="md" tone="accent" />
            </div>
          </SeamCell>
          <SeamCell>
            <Label>Sets</Label>
            <div className="mt-1">
              <Metric value={s.completedSets} size="md" />
            </div>
          </SeamCell>
        </Seam>

        {s.xpAwarded > 0 ? <Chip tone="accent">+{s.xpAwarded} XP</Chip> : null}

        {/* — Records ————————————————————————————————————————— */}

        {s.personalRecords.length > 0 ? (
          <>
            <SectionRule>{copy('prTitle')}</SectionRule>
            {s.personalRecords.map((pr) => (
              <Panel key={`${pr.exerciseName}-${pr.kind}`} tone="good" className="flex items-center gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <Display size="sm" as="h3" className="truncate">
                    {pr.exerciseName}
                  </Display>
                  <p className="mt-0.5 font-utility text-[10px] uppercase tracking-[0.12em] text-foam-45">
                    {pr.label ? units.text(pr.label) : pr.kind.replace(/_/g, ' ')}
                  </p>
                </div>
                <Metric
                  value={isLoadRecord(pr.kind) ? units.value(pr.value) : Math.round(pr.value)}
                  unit={isLoadRecord(pr.kind) ? units.unit : undefined}
                  size="md"
                  tone="good"
                />
              </Panel>
            ))}
          </>
        ) : null}

        {/* Safety signal — plain register, always. */}
        {volumeWarning ? (
          <Panel tone={volumeWarning.level === 'high' ? 'bad' : 'warn'} className="flex flex-col gap-1.5 p-4">
            <Label>Load check</Label>
            <p className="text-[13px] leading-relaxed text-foam-65">{volumeWarning.message}</p>
          </Panel>
        ) : null}

        {/* — Breakdown ——————————————————————————————————————— */}

        <SectionRule>Lift by lift</SectionRule>
        <Panel className="flex flex-col">
          {s.byExercise.map((row) => (
            <div key={row.exerciseId} className="flex items-center gap-3 border-b border-line px-3.5 py-2.5 last:border-b-0">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px]">{row.exerciseName}</p>
                <p className="mt-0.5 font-utility text-[10px] uppercase tracking-[0.12em] text-foam-35">
                  {row.sets} sets · top {units.format(row.topSetKg)} × {row.topSetReps}
                </p>
              </div>
              <div className="text-right">
                <p className="font-display text-[15px] tabular-nums">{units.value(row.volumeKg, 0)}</p>
                <p className="font-utility text-[9px] uppercase tracking-[0.1em] text-foam-35">{units.unit}</p>
              </div>
            </div>
          ))}
        </Panel>

        {s.muscleVolume.length > 0 ? (
          <>
            <SectionRule>Where it landed</SectionRule>
            <Panel className="flex flex-col gap-2 p-4">
              {s.muscleVolume.map((m) => (
                <div key={m.muscle} className="flex items-center gap-2">
                  <span className="w-24 flex-none truncate text-[12px]">{m.label}</span>
                  <span className="flex-1">
                    <Bar value={m.share} max={100} tone="accent" />
                  </span>
                  <span className="w-8 flex-none text-right font-display text-[13px] tabular-nums">{m.sets}</span>
                </div>
              ))}
            </Panel>
          </>
        ) : null}

        {s.coachNote ? (
          <Panel tone="accent" className="flex flex-col gap-1.5 p-4">
            <Label>From your coach</Label>
            <p className="text-[13px] leading-relaxed text-foam-65">{s.coachNote}</p>
          </Panel>
        ) : null}

        {s.notes ? (
          <Panel className="flex flex-col gap-1.5 p-4">
            <Label>Your notes</Label>
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foam-65">{s.notes}</p>
          </Panel>
        ) : null}
      </Stack>
    </Frame>
  );
}

/** What a member shares: the session, never anything about their account. */
function shareText(title: string, volumeKg: number, durationSec: number, units: Units): string {
  return `${title}: ${units.format(volumeKg, 0)} moved in ${minutes(durationSec)}. Logged with Shark Fitness.`;
}

/**
 * Summary sits outside the tab bar (like the workout itself), so in an
 * installed app it needs its own way out: Done returns Home, and Share opens
 * the system share sheet where the browser has one.
 */
function Frame({ children, share }: { children: ReactNode; share: string | null }) {
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  return (
    <>
      <ScreenBody>{children}</ScreenBody>
      <footer className="sf-safe-bottom sf-safe-x flex flex-none gap-2.5 border-t border-line bg-hull pt-3">
        {share && canShare ? (
          <button
            type="button"
            onClick={() => void navigator.share({ title: 'Shark Fitness', text: share }).catch(() => undefined)}
            className="sf-btn mb-3 min-h-12 flex-1"
          >
            Share
          </button>
        ) : null}
        <Link to="/" className={cx('sf-cta mb-3 min-h-12', share && canShare ? 'flex-1' : 'w-full')}>
          Done
        </Link>
      </footer>
    </>
  );
}
