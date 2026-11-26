import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Viewer } from '@shark/contracts';

const api = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
const route = vi.hoisted(() => ({ search: {} as { mode?: string } }));
const net = vi.hoisted(() => ({ online: true, queued: 0 }));
const enqueue = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/api')>()), api }));
vi.mock('../../lib/outbox', () => ({ enqueue, useOutboxCount: () => net.queued }));
vi.mock('../../lib/realtime', () => ({ useOnline: () => net.online }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useSearch: () => route.search,
}));

import { ApiError, OfflineError } from '../../lib/api';
import WorkoutScreen, { readDoneSnapshot, readSessionPlan, type SessionPlan } from '../Workout';
import { useSession, useWorkout } from '../../lib/store';

const viewer = {
  userId: 'usr_aman', tenantId: 'ten_shark', memberId: 'mbr_aman', staffId: null, name: 'Aman Mehta', initials: 'AM', email: null,
  role: 'member', accountState: 'active', homeBranchId: 'br_kor', permittedBranchIds: ['br_kor'], permissions: [],
  preferences: { register: 'plain', unitSystem: 'metric', theme: 'dark', haptics: true, reducedMotion: false },
} as Viewer;

const set = (setIndex: number, targetWeightKg: number, overrides: Record<string, unknown> = {}) => ({
  setIndex, targetWeightKg, repLow: 5, repHigh: 5, targetRpe: 8, restSec: 120, isWarmup: false, ...overrides,
});

const item = (overrides: Record<string, unknown> = {}) => ({
  id: 'pit_1', orderIndex: 0, exerciseId: 'ex_bench', exerciseName: 'Bench press', equipment: 'barbell', primaryMuscles: ['chest'], muscleLabels: ['Chest'],
  usesBarbell: true, mediaUrl: null, archived: false, targetLabel: '2 × 5 @ RPE 8', sets: [set(0, 60), set(1, 60)], targetKg: 60, plateLabel: '20',
  restSec: 120, supersetGroup: null, tempo: null, notes: 'Pause on the chest.', rationale: null, trainerLocked: false, allowedSubstitutionIds: [],
  substitutedFrom: null, lastPerformance: { weightKg: 57.5, reps: 5, at: '2026-11-19', atLabel: 'Thu', label: '57.5 kg × 5' }, recovery: null, adaptive: null,
  ...overrides,
});

/** GET /member/training/plan as routes/member/training.ts sends it: today's
 *  day is identified by `programDayId`. */
function plan(today: Record<string, unknown> | null = {}, rest: Record<string, unknown> = {}) {
  return {
    assignment: { id: 'asg_1', startsOn: '2026-11-09', currentWeek: 3, currentBlock: 'Strength', state: 'active', trainerName: 'Rehan Khan', programVersion: 2 },
    program: { id: 'prg_1', name: 'Foundations', version: 2, goal: 'strength', daysPerWeek: 3, weeks: 8, authorName: 'Rehan Khan', description: '' },
    week: { number: 3, of: 8, block: 'Strength', startsOn: '2026-11-23', days: [], setsThisWeek: 0, setsLastWeek: 0, volumeWarning: null },
    today:
      today === null
        ? null
        : {
            programDayId: 'pd_thu', date: '2026-11-26', label: 'Upper A', focus: 'upper', isRest: false, estimatedMin: 50, done: false,
            items: [item(), item({ id: 'pit_2', orderIndex: 1, exerciseId: 'ex_row', exerciseName: 'Barbell row', primaryMuscles: ['lats'], sets: [set(0, 50)], notes: null, lastPerformance: null })],
            ...today,
          },
    adaptive: null,
    explanation: null,
    muscleSplit: [],
    injuryHold: null,
    resume: null,
    ...rest,
  };
}

function renderWorkout() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <WorkoutScreen />
    </QueryClientProvider>,
  );
}

/** The ledger row's Log button (the big call to action below carries the same name). */
const logButton = (n: number) => screen.getAllByRole('button', { name: `Log set ${n}` })[0]!;
const findLogButton = async (n: number) => (await screen.findAllByRole('button', { name: `Log set ${n}` }))[0]!;

const drafts = () => enqueue.mock.calls.map(([entry]) => entry as { clientId: string; kind: string; method: string; path: string; body: Record<string, unknown> });

beforeEach(() => {
  localStorage.clear();
  useWorkout.getState().reset();
  useSession.setState({ viewer, status: 'signed-in' } as never);
  route.search = {};
  net.online = true;
  net.queued = 0;
  enqueue.mockResolvedValue(undefined);
});
afterEach(() => {
  api.mockReset();
  navigate.mockReset();
  enqueue.mockReset();
});

describe('Workout', () => {
  it('shows a loading skeleton while today’s plan loads', () => {
    api.mockReturnValue(new Promise(() => undefined));
    const { container } = renderWorkout();
    expect(container.querySelector('.sf-skeleton')).not.toBeNull();
  });

  it('seeds a session from today’s plan and keeps a copy on the phone', async () => {
    api.mockResolvedValue(plan());
    renderWorkout();
    expect(await screen.findByRole('heading', { level: 1, name: 'Bench press' })).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith('/member/training/plan');
    expect(screen.getByText('Exercise 1 of 2 · 2 × 5 @ RPE 8 · 60 kg')).toBeInTheDocument();
    expect(screen.getByText('Train · set 0 of 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set 1, 60 kg for 5 reps' })).toBeInTheDocument();
    expect(screen.getByText('Last time 57.5 kg × 5')).toBeInTheDocument();
    expect(screen.getByText('Pause on the chest.')).toBeInTheDocument();
    // Frozen locally so a killed app resumes complete.
    const saved = readSessionPlan();
    expect(saved?.title).toBe('Upper A');
    expect(saved?.programDayId).toBe('pd_thu');
    expect(saved?.exercises.map((e) => e.exerciseName)).toEqual(['Bench press', 'Barbell row']);
    expect(JSON.parse(localStorage.getItem('shark.workout') ?? '{}').sets).toHaveLength(3);
  });

  it('logging a set queues the whole draft through the outbox, with the plan day, and starts the rest clock', async () => {
    api.mockResolvedValue(plan());
    renderWorkout();
    await screen.findByRole('heading', { level: 1, name: 'Bench press' });
    fireEvent.click(screen.getByRole('button', { name: 'Increase weight by 2.5' }));
    fireEvent.click(screen.getByRole('button', { name: '8' }));
    fireEvent.click(logButton(1));

    expect(screen.getByRole('button', { name: 'Undo set 1' })).toBeInTheDocument();
    expect(screen.getByText('Rest remaining')).toBeInTheDocument();
    expect(screen.getByText('Train · set 1 of 3')).toBeInTheDocument();
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [draft] = drafts();
    expect(draft).toMatchObject({ kind: 'workout-set', method: 'POST', path: '/member/training/workouts' });
    expect(draft!.body).toMatchObject({
      assignmentId: 'asg_1',
      // The server requires the key (nullable, never absent).
      programDayId: 'pd_thu',
      branchId: null,
      title: 'Upper A',
      state: 'in_progress',
      finishedAt: null,
      sets: [expect.objectContaining({ exerciseId: 'ex_bench', setIndex: 0, weightKg: 62.5, reps: 5, rpe: 8, isWarmup: false })],
    });
    // Keyed on the set, so a retry of this write is the same write.
    expect(draft!.clientId).toBe((draft!.body.sets as Array<{ clientId: string }>)[0]!.clientId);

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(screen.queryByText('Rest remaining')).not.toBeInTheDocument();
  });

  it('undo takes a set back and queues the corrected draft', async () => {
    api.mockResolvedValue(plan());
    renderWorkout();
    fireEvent.click(await findLogButton(1));
    fireEvent.click(screen.getByRole('button', { name: 'Undo set 1' }));
    expect(logButton(1)).toBeInTheDocument();
    expect(drafts().at(-1)!.body.sets).toEqual([]);
  });

  it('moves to the next exercise once every set of this one is logged', async () => {
    api.mockResolvedValue(plan());
    renderWorkout();
    fireEvent.click(await findLogButton(1));
    fireEvent.click(logButton(2));
    expect(await screen.findByRole('heading', { level: 1, name: 'Barbell row' })).toBeInTheDocument();
    expect(screen.getByText('First time on this lift')).toBeInTheDocument();
  });

  it('finishing saves the session through the outbox, keeps a local summary and opens it', async () => {
    api.mockResolvedValue(plan());
    renderWorkout();
    fireEvent.click(await findLogButton(1));
    const clientId = readSessionPlan()!.clientId;
    // Resting: the pinned bar shows Skip, so finish from the header.
    fireEvent.click(screen.getByRole('button', { name: 'Finish this session' }));
    const sheet = screen.getByRole('dialog', { name: 'Finish session' });
    expect(sheet).toHaveTextContent('2 of 3 sets are unlogged. Finishing here is fine');
    fireEvent.click(within(sheet).getByRole('button', { name: '7' }));
    fireEvent.change(within(sheet).getByRole('textbox'), { target: { value: 'Left shoulder tight on set 1.' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save session' }));

    const finish = drafts().at(-1)!;
    expect(finish.kind).toBe('workout-finish');
    expect(finish.clientId).toBe(`${clientId}:finish`);
    expect(finish.body).toMatchObject({ clientId, programDayId: 'pd_thu', state: 'completed', sessionRpe: 7, notes: 'Left shoulder tight on set 1.' });
    expect(finish.body.finishedAt).toEqual(expect.any(String));
    expect(navigate).toHaveBeenCalledWith({ to: '/workout/summary/$workoutId', params: { workoutId: clientId } });
    // Summary can show the numbers before the server has the session.
    expect(readDoneSnapshot(clientId)).toMatchObject({ title: 'Upper A', completedSets: 1, totalSets: 3, volumeKg: 300 });
    expect(readSessionPlan()).toBeNull();
    expect(useWorkout.getState().clientId).toBeNull();
  });

  it('leaving with nothing logged discards the session and writes nothing', async () => {
    api.mockResolvedValue(plan());
    renderWorkout();
    fireEvent.click(await screen.findByRole('button', { name: 'Finish this session' }));
    const sheet = screen.getByRole('dialog', { name: 'Leave this session?' });
    expect(sheet).toHaveTextContent('Nothing has been logged yet, so there is nothing to save.');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Keep going' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Finish this session' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(navigate).toHaveBeenCalledWith({ to: '/' });
    expect(enqueue).not.toHaveBeenCalled();
    expect(readSessionPlan()).toBeNull();
  });

  it('offline: says what is safe on the phone, and logging still lands and queues', async () => {
    api.mockResolvedValue(plan());
    net.online = false;
    net.queued = 2;
    renderWorkout();
    await screen.findByRole('heading', { level: 1, name: 'Bench press' });
    expect(screen.getByText('Offline. 2 sets are saved on this phone and will send themselves when signal comes back.')).toBeInTheDocument();
    expect(screen.getByText('2 queued')).toBeInTheDocument();
    fireEvent.click(logButton(1));
    expect(screen.getByRole('button', { name: 'Undo set 1' })).toBeInTheDocument();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ kind: 'workout-set', path: '/member/training/workouts' }));
  });

  it('back online with writes waiting: says they are syncing', async () => {
    api.mockResolvedValue(plan());
    net.queued = 1;
    renderWorkout();
    expect(await screen.findByText('Syncing 1 set to your coach.')).toBeInTheDocument();
  });

  it('resumes a session from the phone with no connection: the plan fetch failing never blocks logging', async () => {
    const saved: SessionPlan = {
      clientId: 'wkt-resume', title: 'Upper A', assignmentId: 'asg_1', programDayId: 'pd_thu', branchId: null, startedAt: Date.now() - 20 * 60_000,
      pausedMs: 0, pausedAt: null, substitutions: [], adaptive: null, adaptiveDecision: 'pending',
      exercises: [{
        orderIndex: 0, exerciseId: 'ex_bench', exerciseName: 'Bench press', equipment: 'barbell', usesBarbell: true, primaryMuscles: ['chest'], secondaryMuscles: [],
        targetLabel: '2 × 5', tempo: null, notes: null, trainerLocked: false, sets: [set(0, 60), set(1, 60)], lastPerformance: null, allowedSubstitutions: [],
      }],
    };
    localStorage.setItem('shark.workout.plan', JSON.stringify(saved));
    useWorkout.getState().start({
      clientId: 'wkt-resume', assignmentId: 'asg_1', programDayId: 'pd_thu', title: 'Upper A',
      sets: [
        { clientId: 's1', exerciseId: 'ex_bench', orderIndex: 0, setIndex: 0, weightKg: 60, reps: 5, rpe: null, done: true, doneAt: '2026-11-26T06:10:00Z' },
        { clientId: 's2', exerciseId: 'ex_bench', orderIndex: 0, setIndex: 1, weightKg: 60, reps: 5, rpe: null, done: false, doneAt: null },
      ],
    });
    api.mockRejectedValue(new OfflineError());
    net.online = false;
    renderWorkout();
    expect(screen.getByRole('heading', { level: 1, name: 'Bench press' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo set 1' })).toBeInTheDocument();
    await waitFor(() => expect(api).toHaveBeenCalled());
    fireEvent.click(logButton(2));
    expect(drafts().at(-1)!.body).toMatchObject({ clientId: 'wkt-resume', sets: [expect.objectContaining({ clientId: 's1' }), expect.objectContaining({ clientId: 's2' })] });
    expect(screen.queryByText(/No connection right now/)).not.toBeInTheDocument();
  });

  it('a coach republishing mid-session is announced, and the session carries on unchanged', async () => {
    api.mockResolvedValueOnce(plan());
    const view = renderWorkout();
    await screen.findByRole('heading', { level: 1, name: 'Bench press' });
    view.unmount();
    api.mockResolvedValue(plan({ programDayId: 'pd_thu_v2', label: 'Upper A (new)' }));
    renderWorkout();
    expect(await screen.findByText('Your plan changed')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Bench press' })).toBeInTheDocument();
    expect(readSessionPlan()?.title).toBe('Upper A');
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryByText('Your plan changed')).not.toBeInTheDocument();
  });

  it('an adaptive change shows its receipt and can be kept as it was', async () => {
    api.mockResolvedValue(
      plan({}, { adaptive: { id: 'adp_1', headline: 'Bench goes up 2.5 kg', explanation: 'Two sessions at RPE 7.', rulesVersion: 'r2026.11', reviewedByName: 'Rehan Khan' } }),
    );
    renderWorkout();
    expect(await screen.findByText('Adaptive rule fired')).toBeInTheDocument();
    expect(screen.getByText('Bench goes up 2.5 kg')).toBeInTheDocument();
    expect(screen.getByText(/Rules r2026\.11 · medium confidence · reviewed by Rehan Khan/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep original' }));
    expect(screen.queryByText('Adaptive rule fired')).not.toBeInTheDocument();
    expect(readSessionPlan()?.adaptiveDecision).toBe('kept');
  });

  it('pausing stops the session clock', async () => {
    api.mockResolvedValue(plan());
    renderWorkout();
    fireEvent.click(await screen.findByRole('button', { name: 'Pause the session clock' }));
    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(readSessionPlan()?.pausedAt).toEqual(expect.any(Number));
    fireEvent.click(screen.getByRole('button', { name: 'Resume the session clock' }));
    expect(readSessionPlan()?.pausedAt).toBeNull();
  });

  it('offline with no session yet: says the plan needs one moment of signal, with a retry and a way back', async () => {
    api.mockRejectedValue(new OfflineError());
    net.online = false;
    renderWorkout();
    // One retry (a second, by design) before the error shows.
    expect(await screen.findByRole('heading', { name: 'No connection right now' }, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText(/Anything you have already logged is safe on this phone/)).toBeInTheDocument();
    api.mockResolvedValue(plan());
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Bench press' })).toBeInTheDocument();
  });

  it('error online: the plan did not come back; Back to today leaves', async () => {
    api.mockRejectedValue(new ApiError(500, { error: { code: 'INTERNAL', message: 'x', requestId: 'r' } }));
    renderWorkout();
    expect(await screen.findByRole('heading', { name: 'Could not load your plan' }, { timeout: 3000 })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to today' }));
    expect(navigate).toHaveBeenCalledWith({ to: '/' });
  });

  it('rest day and no plan: empty states that still offer a session of your own', async () => {
    api.mockResolvedValueOnce(plan({ isRest: true, label: 'Rest', items: [] }));
    const first = renderWorkout();
    expect(await screen.findByRole('heading', { name: 'Rest day' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Log a workout' }));
    expect(navigate).toHaveBeenCalledWith({ to: '/workout', search: { mode: 'freestyle' } });
    first.unmount();

    api.mockResolvedValueOnce(plan(null));
    renderWorkout();
    expect(await screen.findByRole('heading', { name: 'No plan for today' })).toBeInTheDocument();
    expect(useWorkout.getState().clientId).toBeNull();
  });

  it('freestyle: builds a session from the library and logs it like any other', async () => {
    route.search = { mode: 'freestyle' };
    api.mockImplementation(async (path: string) =>
      path === '/member/training/exercises'
        ? { items: [{ id: 'ex_goblet', name: 'Goblet squat', aliases: [], equipment: 'dumbbell', usesBarbell: false, primaryMuscles: ['quads'], secondaryMuscles: [], defaultRestSec: 90, lastPerformance: null }] }
        : plan(),
    );
    renderWorkout();
    fireEvent.click(await screen.findByRole('button', { name: 'Goblet squat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start · 1 exercise' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Goblet squat' })).toBeInTheDocument();
    expect(readSessionPlan()).toMatchObject({ title: 'Freestyle workout', assignmentId: null, programDayId: null });
    fireEvent.click(logButton(1));
    expect(drafts().at(-1)!.body).toMatchObject({ title: 'Freestyle workout', assignmentId: null, programDayId: null, branchId: null });
  });
});
