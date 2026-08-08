import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { MuscleGroup } from '@shark/contracts';
import { MUSCLE_LABEL, muscleShare, platesPerSide, sessionVolumeKg } from '@shark/domain';
import { api } from '../lib/api';
import { enqueue, useOutboxCount } from '../lib/outbox';
import { useOnline } from '../lib/realtime';
import { type ActiveSet, useCopy, useWorkout } from '../lib/store';
import { ScreenBody } from '../ui/shell';
import {
  Bar,
  Button,
  Chip,
  Display,
  EmptyState,
  ErrorState,
  Eyebrow,
  Label,
  Metric,
  Panel,
  SectionRule,
  Skeleton,
  cx,
} from '../ui/primitives';

/* ============================================================================
   Active workout (UX-M05).

   Three rules shape this file.

   1. The network is optional. Every logged set is written to localStorage by
      the store and to the outbox in the same tick, before anything is drawn.
      A dead connection costs a retry and nothing else (PF-WORK-004/005).
   2. The plan is cached locally too. React Query's cache does not survive a
      killed app, so the session's exercise names, targets, muscles and
      substitutions are snapshotted at seed time. Resuming in a basement with
      no signal shows a complete screen, not a list of UUIDs.
   3. An in-progress session is never mutated by a plan change (PF-WORK-003).
      If the coach republishes mid-session we say so and carry on.
   ========================================================================= */

/* — Local session cache ————————————————————————————————————— */

const PLAN_KEY = 'shark.workout.plan';
const DONE_PREFIX = 'shark.workout.done.';

export interface SessionSet {
  setIndex: number;
  targetWeightKg: number | null;
  repLow: number;
  repHigh: number;
  targetRpe: number | null;
  restSec: number;
  isWarmup: boolean;
}

export interface SessionSubstitute {
  id: string;
  name: string;
  equipment: string;
  usesBarbell: boolean;
}

export interface SessionExercise {
  orderIndex: number;
  exerciseId: string;
  exerciseName: string;
  equipment: string;
  usesBarbell: boolean;
  primaryMuscles: MuscleGroup[];
  secondaryMuscles: MuscleGroup[];
  targetLabel: string;
  tempo: string | null;
  notes: string | null;
  trainerLocked: boolean;
  sets: SessionSet[];
  lastPerformance: { weightKg: number; reps: number; label: string } | null;
  allowedSubstitutions: SessionSubstitute[];
}

export interface SessionAdaptive {
  id: string;
  exerciseId: string | null;
  headline: string;
  explanation: string;
  rulesVersion: string;
  confidence: string;
  limitations: string;
  reviewedByName: string | null;
  newLoadKg: number | null;
}

/** The whole session, frozen at seed time so a killed app resumes complete. */
export interface SessionPlan {
  clientId: string;
  title: string;
  assignmentId: string | null;
  programDayId: string | null;
  branchId: string | null;
  startedAt: number;
  /** Milliseconds spent paused, excluded from the elapsed clock. */
  pausedMs: number;
  pausedAt: number | null;
  exercises: SessionExercise[];
  substitutions: Array<{ fromExerciseId: string; toExerciseId: string; reason: string }>;
  adaptive: SessionAdaptive | null;
  adaptiveDecision: 'pending' | 'applied' | 'kept';
}

/** What the summary screen can show before the server has ever seen the session. */
export interface DoneSnapshot {
  clientId: string;
  title: string;
  startedAt: string;
  finishedAt: string;
  durationSec: number;
  volumeKg: number;
  totalSets: number;
  completedSets: number;
  exerciseCount: number;
  sessionRpe: number | null;
  muscleVolume: Array<{ muscle: MuscleGroup; label: string; sets: number; share: number }>;
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode — the in-memory session still works */
  }
}

export function readSessionPlan(): SessionPlan | null {
  return readJson<SessionPlan>(PLAN_KEY);
}

export function readDoneSnapshot(clientId: string): DoneSnapshot | null {
  return readJson<DoneSnapshot>(`${DONE_PREFIX}${clientId}`);
}

/** One finished session is kept for the summary screen; older ones are dropped. */
function writeDoneSnapshot(snapshot: DoneSnapshot): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && key.startsWith(DONE_PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    /* nothing to clean up */
  }
  writeJson(`${DONE_PREFIX}${snapshot.clientId}`, snapshot);
}

/* — The plan endpoint, as this screen consumes it ——————————————

   GET /v1/member/training/plan is owned by the train-plan slice. This screen
   reads the ProgramDay / ProgramItem shape from @shark/contracts and tolerates
   the day arriving as `today`, `day`, or inside `days` keyed by `dayIndex`.
   Substitutions must arrive with names attached: the picker has to work with
   no connection, so resolving an id against a library endpoint is not an
   option on this screen.                                                  */

interface RawItem {
  orderIndex: number;
  exerciseId: string;
  exerciseName: string;
  equipment?: string;
  usesBarbell?: boolean;
  primaryMuscles?: string[];
  secondaryMuscles?: string[];
  targetLabel?: string;
  tempo?: string | null;
  notes?: string | null;
  trainerLocked?: boolean;
  sets?: Array<{
    setIndex?: number;
    targetWeightKg?: number | null;
    repLow?: number;
    repHigh?: number;
    targetRpe?: number | null;
    restSec?: number;
    isWarmup?: boolean;
  }>;
  lastPerformance?: { weightKg: number; reps: number; label?: string } | null;
  allowedSubstitutions?: Array<{ id: string; name: string; equipment?: string; usesBarbell?: boolean }>;
}

interface RawDay {
  id: string;
  dayIndex?: number;
  label?: string;
  focus?: string;
  isRest?: boolean;
  estimatedMin?: number;
  items?: RawItem[];
}

interface PlanPayload {
  assignment?: { id: string; currentWeek?: number; currentBlock?: string; trainerName?: string | null } | null;
  branchId?: string | null;
  today?: RawDay | null;
  day?: RawDay | null;
  days?: RawDay[];
  adaptive?: {
    id: string;
    exerciseId?: string | null;
    headline: string;
    explanation: string;
    rulesVersion: string;
    confidence?: string;
    limitations?: string;
    reviewedByName?: string | null;
    newLoadKg?: number | null;
  } | null;
}

function todayOf(payload: PlanPayload): RawDay | null {
  if (payload.today) return payload.today;
  if (payload.day) return payload.day;
  if (payload.days?.length) {
    const index = (new Date().getDay() + 6) % 7;
    return payload.days.find((d) => d.dayIndex === index) ?? null;
  }
  return null;
}

function normaliseExercises(day: RawDay): SessionExercise[] {
  return (day.items ?? [])
    .slice()
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((item) => ({
      orderIndex: item.orderIndex,
      exerciseId: item.exerciseId,
      exerciseName: item.exerciseName,
      equipment: item.equipment ?? 'other',
      usesBarbell: item.usesBarbell ?? false,
      primaryMuscles: (item.primaryMuscles ?? []) as MuscleGroup[],
      secondaryMuscles: (item.secondaryMuscles ?? []) as MuscleGroup[],
      targetLabel: item.targetLabel ?? '',
      tempo: item.tempo ?? null,
      notes: item.notes ?? null,
      trainerLocked: item.trainerLocked ?? false,
      sets: (item.sets ?? []).map((s, i) => ({
        setIndex: s.setIndex ?? i,
        targetWeightKg: s.targetWeightKg ?? null,
        repLow: s.repLow ?? 8,
        repHigh: s.repHigh ?? s.repLow ?? 8,
        targetRpe: s.targetRpe ?? null,
        restSec: s.restSec ?? 90,
        isWarmup: s.isWarmup ?? false,
      })),
      lastPerformance: item.lastPerformance
        ? {
            weightKg: item.lastPerformance.weightKg,
            reps: item.lastPerformance.reps,
            label: item.lastPerformance.label ?? `${item.lastPerformance.weightKg} kg × ${item.lastPerformance.reps}`,
          }
        : null,
      allowedSubstitutions: (item.allowedSubstitutions ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        equipment: s.equipment ?? 'other',
        usesBarbell: s.usesBarbell ?? false,
      })),
    }));
}

function seedSets(exercises: SessionExercise[]): ActiveSet[] {
  const out: ActiveSet[] = [];
  for (const exercise of exercises) {
    for (const prescribed of exercise.sets) {
      out.push({
        clientId: crypto.randomUUID(),
        exerciseId: exercise.exerciseId,
        orderIndex: exercise.orderIndex,
        setIndex: prescribed.setIndex,
        weightKg: prescribed.targetWeightKg ?? exercise.lastPerformance?.weightKg ?? 0,
        reps: prescribed.repHigh,
        rpe: null,
        done: false,
        doneAt: null,
      });
    }
  }
  return out;
}

/* — Time ————————————————————————————————————————————————— */

function clock(totalSec: number): string {
  const safe = Math.max(0, Math.round(totalSec));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/* — Screen ————————————————————————————————————————————————— */

export default function WorkoutScreen() {
  const copy = useCopy();
  const navigate = useNavigate();
  const online = useOnline();
  const queued = useOutboxCount();

  const active = useWorkout();
  const [session, setSession] = useState<SessionPlan | null>(() => readSessionPlan());
  const [now, setNow] = useState(() => Date.now());
  const [finishing, setFinishing] = useState(false);
  const [substituting, setSubstituting] = useState(false);
  const [planChanged, setPlanChanged] = useState(false);
  const [lastLogged, setLastLogged] = useState<string | null>(null);

  const resuming = active.clientId !== null;

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['training', 'plan'],
    queryFn: () => api<PlanPayload>('/member/training/plan'),
    // A resumed session already has everything it needs cached locally, so a
    // failed plan fetch must never block logging.
    retry: resuming ? false : 1,
    staleTime: 60_000,
  });

  /* One ticker drives the elapsed clock and the rest countdown. Both are
     derived from timestamps, so backgrounding the tab cannot make them drift. */
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  /* Seed a new session from today's plan. Never touches a session already in
     progress — that is what makes the resume path safe. */
  useEffect(() => {
    if (active.clientId || !data) return;
    const day = todayOf(data);
    if (!day || day.isRest) return;
    const exercises = normaliseExercises(day);
    if (exercises.length === 0) return;

    const clientId = crypto.randomUUID();
    const plan: SessionPlan = {
      clientId,
      title: day.label ?? 'Training session',
      assignmentId: data.assignment?.id ?? null,
      programDayId: day.id,
      branchId: data.branchId ?? null,
      startedAt: Date.now(),
      pausedMs: 0,
      pausedAt: null,
      exercises,
      substitutions: [],
      adaptive: data.adaptive
        ? {
            id: data.adaptive.id,
            exerciseId: data.adaptive.exerciseId ?? null,
            headline: data.adaptive.headline,
            explanation: data.adaptive.explanation,
            rulesVersion: data.adaptive.rulesVersion,
            confidence: data.adaptive.confidence ?? 'medium',
            limitations:
              data.adaptive.limitations ??
              'Estimates from what you logged. Tell your coach if anything hurts.',
            reviewedByName: data.adaptive.reviewedByName ?? null,
            newLoadKg: data.adaptive.newLoadKg ?? null,
          }
        : null,
      adaptiveDecision: 'pending',
    };

    writeJson(PLAN_KEY, plan);
    setSession(plan);
    useWorkout.getState().start({
      clientId,
      assignmentId: plan.assignmentId,
      programDayId: plan.programDayId,
      title: plan.title,
      sets: seedSets(exercises),
    });
  }, [data, active.clientId]);

  /* The coach republished mid-session. Say so; change nothing (PF-WORK-003). */
  useEffect(() => {
    if (!data || !session || !active.clientId) return;
    const day = todayOf(data);
    if (day && session.programDayId && day.id !== session.programDayId) setPlanChanged(true);
  }, [data, session, active.clientId]);

  const save = useCallback((next: SessionPlan) => {
    writeJson(PLAN_KEY, next);
    setSession(next);
  }, []);

  /* — The draft that goes over the wire ——————————————————————— */

  const warmupOf = useCallback(
    (set: ActiveSet): boolean =>
      session?.exercises
        .find((e) => e.orderIndex === set.orderIndex)
        ?.sets.find((s) => s.setIndex === set.setIndex)?.isWarmup ?? false,
    [session],
  );

  const buildDraft = useCallback(
    (plan: SessionPlan, sets: ActiveSet[], notes: string, sessionRpe: number | null, finished: boolean) => ({
      clientId: plan.clientId,
      assignmentId: plan.assignmentId,
      programDayId: plan.programDayId,
      branchId: plan.branchId,
      title: plan.title,
      startedAt: new Date(plan.startedAt).toISOString(),
      finishedAt: finished ? new Date().toISOString() : null,
      state: finished ? ('completed' as const) : ('in_progress' as const),
      sets: sets
        .filter((s) => s.done && s.doneAt)
        .map((s) => ({
          clientId: s.clientId,
          exerciseId: s.exerciseId,
          orderIndex: s.orderIndex,
          setIndex: s.setIndex,
          weightKg: s.weightKg,
          reps: s.reps,
          rpe: s.rpe,
          isWarmup: warmupOf(s),
          doneAt: s.doneAt as string,
        })),
      notes: notes.trim() ? notes.trim() : null,
      sessionRpe,
      substitutions: plan.substitutions,
    }),
    [warmupOf],
  );

  /**
   * Queue the whole draft, keyed on whatever just changed.
   *
   * Sending the complete draft every time — not a delta — is what makes signal
   * loss survivable: a later entry is a superset of every earlier one, so if
   * three queued writes are lost and the fourth lands, nothing is missing.
   * The server upserts on (memberId, clientId) for the workout and for every
   * set, and reconciles its set list to the draft's, which is what makes an
   * undo propagate.
   */
  const queueDraft = useCallback(
    (key: string, finished: boolean) => {
      const plan = readSessionPlan();
      if (!plan) return;
      const state = useWorkout.getState();
      void enqueue({
        clientId: key,
        kind: finished ? 'workout-finish' : 'workout-set',
        method: 'POST',
        path: '/member/training/workouts',
        body: buildDraft(plan, state.sets, state.notes, state.sessionRpe, finished),
      });
    },
    [buildDraft],
  );

  /* — Derived view state ————————————————————————————————————— */

  const exercises = session?.exercises ?? [];
  const exerciseIndex = Math.min(active.exerciseIndex, Math.max(0, exercises.length - 1));
  const exercise = exercises[exerciseIndex];

  const doneCount = active.sets.filter((s) => s.done).length;
  const totalCount = active.sets.length;

  const rows = useMemo(
    () => (exercise ? active.sets.filter((s) => s.orderIndex === exercise.orderIndex) : []),
    [active.sets, exercise],
  );

  const current = rows.find((s) => !s.done) ?? rows[rows.length - 1];
  const prescribed = exercise?.sets.find((s) => s.setIndex === current?.setIndex);

  const elapsedSec = session
    ? Math.max(
        0,
        ((session.pausedAt ?? now) - session.startedAt - session.pausedMs) / 1000,
      )
    : 0;

  const restRemaining = active.restEndsAt ? Math.max(0, (active.restEndsAt - now) / 1000) : 0;
  const resting = restRemaining > 0;

  const plates =
    exercise?.usesBarbell && current ? platesPerSide(current.weightKg) : null;

  /* — Actions ————————————————————————————————————————————— */

  const logSet = (set: ActiveSet): void => {
    const rest = exercise?.sets.find((s) => s.setIndex === set.setIndex)?.restSec ?? 90;
    useWorkout.getState().logSet(set.clientId, rest);
    setLastLogged(set.clientId);
    queueDraft(set.clientId, false);

    // Move on once the last set of an exercise lands, so the header always
    // shows what is actually next.
    const remaining = useWorkout
      .getState()
      .sets.filter((s) => s.orderIndex === set.orderIndex && !s.done);
    if (remaining.length === 0 && exerciseIndex < exercises.length - 1) {
      useWorkout.getState().goToExercise(exerciseIndex + 1);
    }
  };

  const undoSet = (set: ActiveSet): void => {
    useWorkout.getState().unlogSet(set.clientId);
    setLastLogged(null);
    queueDraft(set.clientId, false);
  };

  const addSet = (): void => {
    const last = rows[rows.length - 1];
    if (last) useWorkout.getState().addSet(last.clientId);
  };

  const togglePause = (): void => {
    if (!session) return;
    save(
      session.pausedAt
        ? { ...session, pausedMs: session.pausedMs + (Date.now() - session.pausedAt), pausedAt: null }
        : { ...session, pausedAt: Date.now() },
    );
  };

  /**
   * Substitute the current exercise.
   *
   * The store exposes no exerciseId edit, so the session is re-seeded through
   * `start` with the swapped set list. Every logged set is carried across
   * untouched and the elapsed clock is read from this screen's own snapshot,
   * so nothing is lost by going through the front door.
   */
  const substitute = (to: SessionSubstitute): void => {
    if (!session || !exercise) return;
    const state = useWorkout.getState();
    const sets = state.sets.map((s) =>
      s.orderIndex === exercise.orderIndex ? { ...s, exerciseId: to.id } : s,
    );

    const next: SessionPlan = {
      ...session,
      exercises: session.exercises.map((e) =>
        e.orderIndex === exercise.orderIndex
          ? {
              ...e,
              exerciseId: to.id,
              exerciseName: to.name,
              equipment: to.equipment,
              usesBarbell: to.usesBarbell,
              trainerLocked: false,
              allowedSubstitutions: [
                { id: exercise.exerciseId, name: exercise.exerciseName, equipment: exercise.equipment, usesBarbell: exercise.usesBarbell },
                ...e.allowedSubstitutions.filter((s) => s.id !== to.id),
              ],
            }
          : e,
      ),
      substitutions: [
        ...session.substitutions.filter((s) => s.fromExerciseId !== exercise.exerciseId),
        { fromExerciseId: exercise.exerciseId, toExerciseId: to.id, reason: 'Swapped on the floor' },
      ],
    };

    save(next);
    state.start({
      clientId: session.clientId,
      assignmentId: session.assignmentId,
      programDayId: session.programDayId,
      title: session.title,
      sets,
    });
    useWorkout.getState().goToExercise(exerciseIndex);
    if (state.notes) useWorkout.getState().setNotes(state.notes);
    if (state.sessionRpe !== null) useWorkout.getState().setSessionRpe(state.sessionRpe);

    setSubstituting(false);
    queueDraft(`${session.clientId}:sub:${exercise.orderIndex}`, false);
  };

  /** Apply the rule the engine fired to every set of that lift not yet logged. */
  const applyAdaptive = (): void => {
    if (!session?.adaptive?.newLoadKg) return;
    const target = session.adaptive.exerciseId;
    const load = session.adaptive.newLoadKg;
    const state = useWorkout.getState();
    for (const set of state.sets) {
      if (set.done) continue;
      if (target && set.exerciseId !== target) continue;
      state.setValue(set.clientId, 'weightKg', load);
    }
    save({ ...session, adaptiveDecision: 'applied' });
  };

  const finish = (): void => {
    if (!session) return;
    const state = useWorkout.getState();
    const logged = state.sets.filter((s) => s.done);

    // Nothing logged — there is no session to keep. Discard rather than write
    // an empty record the member will have to explain to their coach.
    if (logged.length === 0) {
      try {
        localStorage.removeItem(PLAN_KEY);
      } catch {
        /* nothing to clean up */
      }
      state.reset();
      void navigate({ to: '/' });
      return;
    }

    const byExercise = new Map(session.exercises.map((e) => [e.exerciseId, e]));
    const shares = muscleShare(
      logged.map((s) => ({
        primary: byExercise.get(s.exerciseId)?.primaryMuscles ?? [],
        secondary: byExercise.get(s.exerciseId)?.secondaryMuscles ?? [],
      })),
    );

    const finishedAt = Date.now();
    writeDoneSnapshot({
      clientId: session.clientId,
      title: session.title,
      startedAt: new Date(session.startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationSec: Math.round(
        (finishedAt - session.startedAt - session.pausedMs - (session.pausedAt ? finishedAt - session.pausedAt : 0)) /
          1000,
      ),
      volumeKg: sessionVolumeKg(
        logged.map((s) => ({ weightKg: s.weightKg, reps: s.reps, isWarmup: warmupOf(s) })),
      ),
      totalSets: state.sets.length,
      completedSets: logged.length,
      exerciseCount: new Set(logged.map((s) => s.exerciseId)).size,
      sessionRpe: state.sessionRpe,
      muscleVolume: shares.map((m) => ({
        muscle: m.muscle,
        label: MUSCLE_LABEL[m.muscle],
        sets: m.sets,
        share: m.share,
      })),
    });

    queueDraft(`${session.clientId}:finish`, true);

    const clientId = session.clientId;
    try {
      localStorage.removeItem(PLAN_KEY);
    } catch {
      /* nothing to clean up */
    }
    state.reset();
    void navigate({ to: '/workout/summary/$workoutId', params: { workoutId: clientId } });
  };

  /* — States ————————————————————————————————————————————— */

  if (!resuming && isLoading) return <WorkoutSkeleton />;

  if (!resuming && (error || !data)) {
    const offline = !online;
    return (
      <Shell>
        <ScreenBody>
          <div className="flex flex-col gap-3.5 p-4">
            <ErrorState
              title={offline ? 'No connection right now' : 'Could not load your plan'}
              body={
                offline
                  ? "Today's plan needs one moment of signal to load. Anything you have already logged is safe on this phone and will sync itself."
                  : 'The plan did not come back. Nothing you have logged before is affected.'
              }
              onRetry={() => void refetch()}
            />
            <Button variant="outline" full onClick={() => void navigate({ to: '/' })}>
              Back to today
            </Button>
          </div>
        </ScreenBody>
      </Shell>
    );
  }

  if (!resuming && !session) {
    const day = data ? todayOf(data) : null;
    return (
      <Shell>
        <ScreenBody>
          <div className="flex flex-col gap-3.5 p-4">
            <EmptyState
              title={day?.isRest ? 'Rest day' : 'No plan for today'}
              body={
                day?.isRest
                  ? 'Nothing is scheduled. Rest is part of the plan — come in for mobility if you want to move, or log a session of your own from the library.'
                  : 'No coach has written today. You can still build a session from the exercise library and log it here.'
              }
              action={
                <Button variant="cta" onClick={() => void navigate({ to: '/train' })}>
                  Open the plan
                </Button>
              }
            />
            <Button variant="outline" full onClick={() => void navigate({ to: '/' })}>
              Back to today
            </Button>
          </div>
        </ScreenBody>
      </Shell>
    );
  }

  if (!session || !exercise || !current) return <WorkoutSkeleton />;

  const paused = session.pausedAt !== null;
  const targetLine = [
    `Exercise ${exerciseIndex + 1} of ${exercises.length}`,
    exercise.targetLabel,
    prescribed?.targetWeightKg ? `${prescribed.targetWeightKg} kg` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Shell>
      {/* — Sticky chrome. One step darker than the canvas, per the token rule. */}
      <header className="sf-safe-top relative flex-none border-b border-line bg-hull">
        <div className="px-4 pb-3 pt-3">
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={togglePause}
              aria-label={paused ? 'Resume the session clock' : 'Pause the session clock'}
              aria-pressed={paused}
              className="grid h-11 w-11 flex-none place-items-center border border-line-strong text-foam hover:border-sonar hover:text-sonar"
            >
              <span aria-hidden="true" className="font-display text-[15px] leading-none">
                {paused ? '▶' : '❙❙'}
              </span>
            </button>

            <div className="min-w-0 flex-1">
              <Eyebrow>
                {paused ? 'Paused' : `${copy('navTrain')} · set ${doneCount} of ${totalCount}`}
              </Eyebrow>
            </div>

            <Metric value={clock(elapsedSec)} size="sm" className="tracking-[0.04em]" />

            <button
              type="button"
              onClick={() => setFinishing(true)}
              aria-label="Finish this session"
              className="grid h-11 w-11 flex-none place-items-center border border-line-strong text-foam hover:border-sonar hover:text-sonar"
            >
              <span aria-hidden="true" className="font-display text-[15px] leading-none">
                ⏹
              </span>
            </button>
          </div>

          <Display size="md" as="h1" className="mt-2 text-pretty">
            {exercise.exerciseName}
          </Display>
          <p className="mt-1.5 text-[12px] text-foam-50">{targetLine}</p>
        </div>

        {/* The progress hairline. Two pixels of the only saturated colour. */}
        <div className="absolute inset-x-0 bottom-0 h-0.5 bg-[var(--sf-data-track)]" aria-hidden="true">
          <div
            className="h-full bg-sonar transition-[width] duration-500"
            style={{ width: `${totalCount > 0 ? (doneCount / totalCount) * 100 : 0}%` }}
          />
        </div>
      </header>

      <ScreenBody>
        <div className="flex flex-col gap-3.5 p-4 pb-6">
          {/* — Offline. Never a dead end: it says what is safe. —————— */}
          {!online || queued > 0 ? (
            <Panel tone={online ? 'plain' : 'warn'} className="flex items-center gap-3 p-3">
              <span
                aria-hidden="true"
                className={cx('font-display text-[15px] leading-none', online ? 'text-sonar' : 'text-flare')}
              >
                {online ? '↻' : '⚑'}
              </span>
              <p className="flex-1 text-[12px] leading-relaxed text-foam-65">
                {online
                  ? `Syncing ${queued} ${queued === 1 ? 'set' : 'sets'} to your coach.`
                  : `Offline. ${queued} ${queued === 1 ? 'set is' : 'sets are'} saved on this phone and will send themselves when signal comes back.`}
              </p>
              <Chip tone={online ? 'accent' : 'warn'}>{queued} queued</Chip>
            </Panel>
          ) : null}

          {/* — The plan moved under us. Nothing is rewritten mid-session. */}
          {planChanged ? (
            <Panel tone="warn" className="p-3.5">
              <Label className="text-flare">Your plan changed</Label>
              <p className="mt-1.5 text-[13px] leading-relaxed text-foam-80">
                Your coach published a new day while you were training. This session keeps the plan you started
                with — the new one is waiting for next time.
              </p>
              <Button className="mt-3" variant="outline" size="sm" onClick={() => setPlanChanged(false)}>
                Got it
              </Button>
            </Panel>
          ) : null}

          {/* — Adaptive rule fired. Flare, with its receipt attached. —— */}
          {session.adaptive && session.adaptiveDecision === 'pending' ? (
            <Panel tone="warn" className="p-3.5">
              <Label className="text-flare">Adaptive rule fired</Label>
              <p className="mt-1.5 font-utility text-[15px] font-semibold">{session.adaptive.headline}</p>
              <p className="mt-1.5 text-[13px] leading-relaxed text-foam-80">{session.adaptive.explanation}</p>
              <p className="mt-2 border-t border-line pt-2 text-[11px] leading-relaxed text-foam-45">
                Rules {session.adaptive.rulesVersion} · {session.adaptive.confidence} confidence
                {session.adaptive.reviewedByName ? ` · reviewed by ${session.adaptive.reviewedByName}` : ''}.{' '}
                {session.adaptive.limitations}
              </p>
              <div className="mt-3 flex gap-2.5">
                {session.adaptive.newLoadKg ? (
                  <Button variant="cta" size="sm" className="flex-1" onClick={applyAdaptive}>
                    Use {session.adaptive.newLoadKg} kg
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => save({ ...session, adaptiveDecision: 'kept' })}
                >
                  Keep original
                </Button>
              </div>
            </Panel>
          ) : null}

          {/* — The exercise rail. Where you are in the session. ———— */}
          <div className="-mx-4 flex gap-0 overflow-x-auto border-y border-line sf-hide-scroll">
            {exercises.map((e, i) => {
              const sets = active.sets.filter((s) => s.orderIndex === e.orderIndex);
              const complete = sets.length > 0 && sets.every((s) => s.done);
              return (
                <button
                  key={e.orderIndex}
                  type="button"
                  onClick={() => useWorkout.getState().goToExercise(i)}
                  aria-current={i === exerciseIndex ? 'true' : undefined}
                  className={cx(
                    'min-h-[52px] min-w-[104px] flex-none cursor-pointer px-3 py-2 text-left',
                    i > 0 && 'border-l border-line',
                    i === exerciseIndex ? 'bg-wash-sonar' : 'hover:bg-wash-sonar-soft',
                  )}
                >
                  <span
                    className={cx(
                      'font-utility text-[10px] font-semibold uppercase tracking-[0.12em]',
                      complete ? 'text-kelp' : i === exerciseIndex ? 'text-sonar' : 'text-foam-45',
                    )}
                  >
                    {complete ? '✓ done' : `${sets.filter((s) => s.done).length}/${sets.length}`}
                  </span>
                  <span className="mt-0.5 block truncate text-[12px] text-foam-80">{e.exerciseName}</span>
                </button>
              );
            })}
          </div>

          {/* — The ledger. Tap a row to select it, tap Log to land it. — */}
          <Panel>
            <div className="flex items-center border-b border-line px-3 py-2">
              <span className="w-9 font-utility text-[10px] font-semibold uppercase tracking-[0.14em] text-foam-45">
                Set
              </span>
              <span className="flex-1 font-utility text-[10px] font-semibold uppercase tracking-[0.14em] text-foam-45">
                Weight
              </span>
              <span className="w-14 font-utility text-[10px] font-semibold uppercase tracking-[0.14em] text-foam-45">
                Reps
              </span>
              <span className="w-[68px] text-right font-utility text-[10px] font-semibold uppercase tracking-[0.14em] text-foam-45">
                Log
              </span>
            </div>

            {rows.map((set) => {
              const target = exercise.sets.find((s) => s.setIndex === set.setIndex);
              const selected = set.clientId === current.clientId;
              return (
                <div
                  key={set.clientId}
                  className={cx(
                    'flex items-center border-b border-line-10 last:border-b-0',
                    set.done && 'bg-wash-kelp',
                    selected && !set.done && 'bg-wash-sonar',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => useWorkout.getState().goToExercise(exerciseIndex)}
                    aria-label={`Set ${set.setIndex + 1}, ${set.weightKg} kilos for ${set.reps} reps`}
                    className="flex min-h-[52px] flex-1 cursor-pointer items-center px-3 text-left"
                  >
                    <span
                      className={cx(
                        'w-9 font-display text-[17px] leading-none',
                        set.done ? 'text-kelp' : selected ? 'text-sonar' : 'text-foam-45',
                      )}
                    >
                      {target?.isWarmup ? 'W' : set.setIndex + 1}
                    </span>
                    <span className="flex-1 font-utility text-[17px] font-semibold tabular-nums">
                      {set.weightKg}
                      <span className="ml-1 text-[12px] text-foam-45">kg</span>
                    </span>
                    <span className="w-14 font-utility text-[17px] font-semibold tabular-nums">{set.reps}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => (set.done ? undoSet(set) : logSet(set))}
                    aria-label={
                      set.done ? `Undo set ${set.setIndex + 1}` : `Log set ${set.setIndex + 1}`
                    }
                    className={cx(
                      'flex min-h-[52px] w-[68px] flex-none cursor-pointer items-center justify-center border-l border-line-10',
                      'font-utility text-[10px] font-semibold uppercase tracking-[0.1em]',
                      set.done ? 'text-kelp hover:text-foam' : 'text-sonar hover:bg-wash-sonar',
                    )}
                  >
                    {set.done ? '✓ undo' : 'log'}
                  </button>
                </div>
              );
            })}

            <div className="flex border-t border-line">
              <button
                type="button"
                onClick={addSet}
                className="min-h-11 flex-1 cursor-pointer border-r border-line font-utility text-[11px] font-semibold uppercase tracking-[0.12em] text-foam-50 hover:text-sonar"
              >
                + Add a set
              </button>
              <button
                type="button"
                onClick={() => setSubstituting(true)}
                disabled={exercise.trainerLocked || exercise.allowedSubstitutions.length === 0}
                className="min-h-11 flex-1 cursor-pointer font-utility text-[11px] font-semibold uppercase tracking-[0.12em] text-foam-50 hover:text-sonar disabled:cursor-not-allowed disabled:opacity-40"
              >
                {exercise.trainerLocked ? 'Locked by coach' : 'Substitute'}
              </button>
            </div>
          </Panel>

          {/* — The set you are on. Everything here is thumb-sized. ——— */}
          {!current.done ? (
            <Panel tone="accent" className="p-3.5">
              <div className="flex items-baseline gap-2">
                <Label>Set {current.setIndex + 1}</Label>
                <span className="flex-1" />
                {exercise.lastPerformance ? (
                  <span className="text-[11px] text-foam-50">Last time {exercise.lastPerformance.label}</span>
                ) : (
                  <span className="text-[11px] text-foam-35">First time on this lift</span>
                )}
              </div>

              <Stepper
                label="Weight"
                unit="kg"
                value={current.weightKg}
                step={2.5}
                onAdjust={(delta) => useWorkout.getState().adjust(current.clientId, 'weightKg', delta)}
              />
              <Stepper
                label="Reps"
                unit={target(prescribed)}
                value={current.reps}
                step={1}
                onAdjust={(delta) => useWorkout.getState().adjust(current.clientId, 'reps', delta)}
              />

              {exercise.usesBarbell ? (
                <p className="mt-3 border-t border-line pt-2.5 font-utility text-[11px] uppercase tracking-[0.12em] text-foam-50">
                  Per side{' '}
                  <span className="text-foam">
                    {plates ? plates.label : 'not loadable with standard plates'}
                  </span>
                </p>
              ) : null}

              {/* RPE stays optional. It is what the adaptive engine reads, and
                  guessing it is worse than leaving it blank. */}
              <div className="mt-3 border-t border-line pt-3">
                <Label>
                  Effort {prescribed?.targetRpe ? `· target RPE ${prescribed.targetRpe}` : '· optional'}
                </Label>
                <div className="mt-2 flex gap-1">
                  {[6, 7, 8, 9, 10].map((rpe) => (
                    <button
                      key={rpe}
                      type="button"
                      onClick={() => useWorkout.getState().setValue(current.clientId, 'rpe', rpe)}
                      aria-pressed={current.rpe === rpe}
                      className={cx(
                        'min-h-11 flex-1 cursor-pointer border font-display text-[16px] leading-none',
                        current.rpe === rpe
                          ? 'border-sonar bg-sonar text-on-accent'
                          : 'border-line text-foam-50 hover:border-sonar hover:text-sonar',
                      )}
                    >
                      {rpe}
                    </button>
                  ))}
                </div>
              </div>

              <Button variant="cta" size="lg" full className="mt-3.5" onClick={() => logSet(current)}>
                Log set {current.setIndex + 1}
              </Button>
            </Panel>
          ) : (
            <Panel tone="good" className="flex items-center gap-3 p-3.5">
              <span aria-hidden="true" className="font-display text-[15px] leading-none text-kelp">
                ✓
              </span>
              <p className="flex-1 text-[13px] text-foam-80">Every set here is logged.</p>
              {lastLogged ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const set = active.sets.find((s) => s.clientId === lastLogged);
                    if (set) undoSet(set);
                  }}
                >
                  Undo last
                </Button>
              ) : null}
            </Panel>
          )}

          {exercise.notes ? (
            <>
              <SectionRule>Coach note</SectionRule>
              <p className="text-[13px] leading-relaxed text-foam-65">{exercise.notes}</p>
            </>
          ) : null}
        </div>
      </ScreenBody>

      {/* — Pinned. Rest and finish are reachable without scrolling. —— */}
      <div className="sf-safe-bottom flex-none border-t border-line bg-hull">
        <div className={cx('flex items-center gap-3 px-4 py-3', resting && 'border-b border-line-accent bg-wash-sonar')}>
          {resting ? (
            <>
              <Metric value={clock(restRemaining)} size="lg" tone="accent" />
              <div className="min-w-0 flex-1">
                <Label>Rest remaining</Label>
                <Bar
                  className="mt-1.5"
                  value={active.restTotalSec - restRemaining}
                  max={active.restTotalSec}
                  height="h-1"
                />
              </div>
              <Button variant="outline" onClick={() => useWorkout.getState().skipRest()}>
                Skip
              </Button>
            </>
          ) : (
            <>
              <Metric value={doneCount} size="lg" />
              <div className="min-w-0 flex-1">
                <Label>{doneCount === totalCount ? 'Every set landed' : `of ${totalCount} sets`}</Label>
                <Bar className="mt-1.5" value={doneCount} max={totalCount} height="h-1" />
              </div>
              <Button variant="cta" onClick={() => setFinishing(true)}>
                {copy('finishSession')}
              </Button>
            </>
          )}
        </div>
      </div>

      {substituting && exercise ? (
        <Sheet title="Substitute this exercise" onClose={() => setSubstituting(false)}>
          <p className="text-[13px] leading-relaxed text-foam-65">
            Swapping {exercise.exerciseName} is recorded for your coach. Sets you have already logged stay
            exactly as they are.
          </p>
          <div className="mt-3.5 flex flex-col">
            {exercise.allowedSubstitutions.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => substitute(option)}
                className="flex min-h-14 cursor-pointer items-center gap-3 border border-line px-3.5 text-left [&+&]:border-t-0 hover:border-sonar hover:text-sonar"
              >
                <span className="flex-1 text-[15px]">{option.name}</span>
                <Label>{option.equipment.replace(/_/g, ' ')}</Label>
              </button>
            ))}
          </div>
        </Sheet>
      ) : null}

      {finishing ? (
        <Sheet title={doneCount === 0 ? 'Leave this session?' : copy('finishSession')} onClose={() => setFinishing(false)}>
          {doneCount === 0 ? (
            <p className="text-[13px] leading-relaxed text-foam-65">
              Nothing has been logged yet, so there is nothing to save. Leaving discards this session and your
              plan stays exactly as it is.
            </p>
          ) : (
            <>
              <div className="flex border border-line">
                <div className="flex-1 border-r border-line px-3 py-2.5">
                  <Metric value={clock(elapsedSec)} size="md" />
                  <Label className="mt-0.5 block">Duration</Label>
                </div>
                <div className="flex-1 border-r border-line px-3 py-2.5">
                  <Metric value={doneCount} size="md" />
                  <Label className="mt-0.5 block">Sets logged</Label>
                </div>
                <div className="flex-1 px-3 py-2.5">
                  <Metric
                    value={sessionVolumeKg(
                      active.sets
                        .filter((s) => s.done)
                        .map((s) => ({ weightKg: s.weightKg, reps: s.reps, isWarmup: warmupOf(s) })),
                    ).toLocaleString('en-IN')}
                    unit="kg"
                    size="md"
                  />
                  <Label className="mt-0.5 block">Volume</Label>
                </div>
              </div>

              {doneCount < totalCount ? (
                <p className="mt-3 text-[12px] leading-relaxed text-foam-50">
                  {totalCount - doneCount} of {totalCount} sets are unlogged. Finishing here is fine — a short
                  session still counts.
                </p>
              ) : null}

              <div className="mt-3.5">
                <Label>How hard was the whole session? Optional</Label>
                <div className="mt-2 flex gap-1">
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((rpe) => (
                    <button
                      key={rpe}
                      type="button"
                      onClick={() => useWorkout.getState().setSessionRpe(rpe)}
                      aria-pressed={active.sessionRpe === rpe}
                      className={cx(
                        'min-h-11 flex-1 cursor-pointer border font-display text-[14px] leading-none',
                        active.sessionRpe === rpe
                          ? 'border-sonar bg-sonar text-on-accent'
                          : 'border-line text-foam-50 hover:border-sonar hover:text-sonar',
                      )}
                    >
                      {rpe}
                    </button>
                  ))}
                </div>
              </div>

              <label className="mt-3.5 block">
                <Label>Anything to tell your coach? Optional</Label>
                <textarea
                  className="sf-field mt-1.5 min-h-[76px]"
                  value={active.notes}
                  onChange={(e) => useWorkout.getState().setNotes(e.target.value)}
                  placeholder="Left knee felt tight on the last squat set."
                />
              </label>
            </>
          )}

          <div className="mt-4 flex gap-2.5">
            <Button variant="outline" className="flex-1" onClick={() => setFinishing(false)}>
              Keep going
            </Button>
            <Button variant={doneCount === 0 ? 'danger' : 'cta'} className="flex-1" onClick={finish}>
              {doneCount === 0 ? 'Discard' : 'Save session'}
            </Button>
          </div>
        </Sheet>
      ) : null}
    </Shell>
  );
}

/* — Pieces ————————————————————————————————————————————————— */

function target(prescribed: SessionSet | undefined): string {
  if (!prescribed) return 'reps';
  return prescribed.repLow === prescribed.repHigh
    ? `target ${prescribed.repLow}`
    : `target ${prescribed.repLow}–${prescribed.repHigh}`;
}

/** Full-bleed shell: this screen deliberately sits outside the tab chrome so
 *  nothing competes with logging a set. */
function Shell({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-0 flex-1 flex-col">{children}</div>;
}

/** 48px targets, Anton numerals. Sized for chalky hands at arm's length. */
function Stepper({ label, unit, value, step, onAdjust }: {
  label: string;
  unit: string;
  value: number;
  step: number;
  onAdjust: (delta: number) => void;
}) {
  return (
    <div className="mt-3">
      <div className="flex items-baseline gap-2">
        <Label>{label}</Label>
        <span className="text-[11px] text-foam-35">{unit}</span>
      </div>
      <div className="mt-1.5 flex items-stretch border border-line-strong">
        <button
          type="button"
          onClick={() => onAdjust(-1)}
          aria-label={`Decrease ${label.toLowerCase()} by ${step}`}
          className="min-h-[52px] w-[56px] flex-none cursor-pointer border-r border-line-strong font-display text-[22px] leading-none text-foam hover:bg-wash-sonar hover:text-sonar"
        >
          <span aria-hidden="true">−</span>
        </button>
        <span className="flex flex-1 items-center justify-center font-display text-[30px] leading-none tabular-nums">
          {value}
        </span>
        <button
          type="button"
          onClick={() => onAdjust(1)}
          aria-label={`Increase ${label.toLowerCase()} by ${step}`}
          className="min-h-[52px] w-[56px] flex-none cursor-pointer border-l border-line-strong font-display text-[22px] leading-none text-foam hover:bg-wash-sonar hover:text-sonar"
        >
          <span aria-hidden="true">+</span>
        </button>
      </div>
    </div>
  );
}

function Sheet({ title, children, onClose }: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="absolute inset-0 z-20 flex flex-col justify-end bg-scrim" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" aria-label="Close" className="flex-1 cursor-pointer" onClick={onClose} />
      <div className="sf-safe-bottom animate-rise border-t border-line-strong bg-overlay">
        <div className="max-h-[72dvh] overflow-y-auto p-4">
          <div className="flex items-center gap-2.5">
            <Eyebrow>{title}</Eyebrow>
            <span className="h-px flex-1 bg-line" />
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="grid h-9 w-9 flex-none place-items-center border border-line-strong hover:border-sonar hover:text-sonar"
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
          <div className="mt-3.5">{children}</div>
        </div>
      </div>
    </div>
  );
}

/** Loading preserves the layout it is about to become. */
function WorkoutSkeleton() {
  return (
    <Shell>
      <div className="sf-safe-top flex-none border-b border-line bg-hull px-4 pb-3 pt-3">
        <div className="flex items-center gap-2.5">
          <Skeleton className="h-11 w-11" />
          <Skeleton className="h-3 w-32 flex-1" />
          <Skeleton className="h-4 w-12" />
        </div>
        <Skeleton className="mt-3 h-8 w-52" />
        <Skeleton className="mt-2 h-3 w-40" />
      </div>
      <ScreenBody>
        <div className="flex flex-col gap-3.5 p-4">
          <Skeleton className="h-[52px] w-full" />
          <Skeleton className="h-[248px] w-full" />
          <Skeleton className="h-[230px] w-full" />
        </div>
      </ScreenBody>
      <div className="sf-safe-bottom flex-none border-t border-line bg-hull p-4">
        <Skeleton className="h-11 w-full" />
      </div>
    </Shell>
  );
}
