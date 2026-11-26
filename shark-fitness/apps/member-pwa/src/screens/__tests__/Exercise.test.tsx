import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/api')>()), api }));
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ exerciseId: 'ex_squat' }),
}));

import { ApiError } from '../../lib/api';
import ExerciseScreen from '../Exercise';
import { useSession } from '../../lib/store';

/** GET /member/training/exercise/:id as routes/member/training.ts sends it. */
function payload(overrides: Record<string, unknown> = {}) {
  return {
    exercise: {
      id: 'ex_squat',
      slug: 'back-squat',
      name: 'Back squat',
      aliases: ['squat'],
      equipment: 'barbell',
      difficulty: 'intermediate',
      primaryMuscles: ['quads', 'glutes'],
      primaryLabels: ['Quads', 'Glutes'],
      secondaryMuscles: ['core'],
      secondaryLabels: ['Core'],
      instructions: ['Bar on your upper back, feet shoulder-width.', 'Sit down between your heels.', 'Drive up through the mid-foot.'],
      cues: ['Chest up', 'Knees out'],
      contraindications: ['Acute lower-back pain'],
      isUnilateral: false,
      usesBarbell: true,
      defaultRestSec: 150,
      loadStepKg: 2.5,
      archived: false,
    },
    media: { url: null, available: false, fallback: 'Demonstration video is not available. The steps and cues below carry the same technique.' },
    prescription: {
      programItemId: 'pit_1',
      programDayId: 'pd_mon',
      dayLabel: 'Lower A',
      dayIndex: 0,
      week: 3,
      targetLabel: '4 × 5 @ RPE 8',
      sets: [
        { setIndex: 0, targetWeightKg: 60, repLow: 5, repHigh: 5, targetRpe: null, restSec: 120, isWarmup: true },
        { setIndex: 1, targetWeightKg: 90, repLow: 5, repHigh: 5, targetRpe: 8, restSec: 150, isWarmup: false },
      ],
      targetKg: 90,
      plateLabel: '20 + 15',
      restSec: 150,
      tempo: '3-1-1',
      notes: null,
      rationale: 'Squats carry your strength block. Keep two reps in reserve.',
      trainerLocked: false,
      supersetGroup: null,
      allowedSubstitutionIds: ['ex_goblet'],
      isToday: true,
    },
    rationale: 'Squats carry your strength block. Keep two reps in reserve.',
    trainerLocked: false,
    lockNote: null,
    alternatives: [
      { id: 'ex_goblet', name: 'Goblet squat', equipment: 'dumbbell', difficulty: 'beginner', primaryMuscles: ['quads'], muscleLabels: ['Quads'], usesBarbell: false, mediaUrl: null, sameMuscles: true },
    ],
    canSubstitute: true,
    recovery: { muscle: 'quads', label: 'Quads', recoveredPct: 72, setsLast7d: 9, note: 'Mostly recovered. Normal session.' },
    adaptive: null,
    history: [],
    ...overrides,
  };
}

function renderExercise() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <ExerciseScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useSession.setState({ viewer: null } as never);
});
afterEach(() => api.mockReset());

describe('Exercise', () => {
  it('shows a loading skeleton first', () => {
    api.mockReturnValue(new Promise(() => undefined));
    const { container } = renderExercise();
    expect(container.querySelector('.sf-skeleton')).not.toBeNull();
  });

  it('renders the server’s exercise: today’s line, the coach’s reason, technique, safety and recovery', async () => {
    api.mockResolvedValue(payload());
    renderExercise();
    expect(await screen.findByRole('heading', { level: 1, name: 'Back squat' })).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith('/member/training/exercise/ex_squat');
    expect(screen.getByText('Quads · Glutes')).toBeInTheDocument();
    expect(screen.getByText('barbell')).toBeInTheDocument();
    expect(screen.getByText('4 × 5 @ RPE 8 · 90 kg')).toBeInTheDocument();
    expect(screen.getByText('Rest 150s · tempo 3-1-1')).toBeInTheDocument();
    expect(screen.getByText('Squats carry your strength block. Keep two reps in reserve.')).toBeInTheDocument();
    // No video: the fallback says so instead of a dead frame.
    expect(screen.getByText(/Demonstration video is not available/)).toBeInTheDocument();
    expect(document.querySelector('video')).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('— Knees out')).toBeInTheDocument();
    expect(screen.getByText('Skip this if')).toBeInTheDocument();
    expect(screen.getByText('— Acute lower-back pain')).toBeInTheDocument();
    expect(screen.getByText('72% recovered · 9 sets in 7 days')).toBeInTheDocument();
  });

  it('with a video, shows it labelled', async () => {
    api.mockResolvedValue(payload({ media: { url: 'https://cdn.example/squat.mp4', available: true, fallback: '' } }));
    renderExercise();
    expect(await screen.findByLabelText('Back squat demonstration')).toHaveAttribute('src', 'https://cdn.example/squat.mp4');
  });

  it('swaps for an allowed alternative and refreshes', async () => {
    api.mockImplementation(async (path: string) => (path === '/member/training/substitute' ? { ok: true } : payload()));
    renderExercise();
    expect(await screen.findByText('Goblet squat')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use this' }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/member/training/substitute', { method: 'POST', body: { exerciseId: 'ex_squat', toExerciseId: 'ex_goblet' } }),
    );
    await waitFor(() => expect(api.mock.calls.filter(([path]) => path === '/member/training/exercise/ex_squat').length).toBe(2));
  });

  it('a refused swap says why instead of doing nothing', async () => {
    api.mockImplementation(async (path: string) => {
      if (path === '/member/training/substitute') {
        throw new ApiError(403, { error: { code: 'FORBIDDEN', message: 'Your coach has locked this exercise. Message them if you need an alternative.', requestId: 'r' } });
      }
      return payload();
    });
    renderExercise();
    fireEvent.click(await screen.findByRole('button', { name: 'Use this' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your coach has locked this exercise.');
  });

  it('locked by the coach: the lock note, no swaps (permission state)', async () => {
    api.mockResolvedValue(
      payload({
        trainerLocked: true,
        lockNote: 'Your coach has locked this exercise. Loads and swaps stay as written until they change it. Message them if it is not working.',
        canSubstitute: false,
      }),
    );
    renderExercise();
    expect(await screen.findByText('Locked by your coach')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use this' })).not.toBeInTheDocument();
  });

  it('not in the plan: no prescription line, technique still there', async () => {
    api.mockResolvedValue(payload({ prescription: null, rationale: null, alternatives: [], canSubstitute: false, recovery: null }));
    renderExercise();
    expect(await screen.findByRole('heading', { level: 1, name: 'Back squat' })).toBeInTheDocument();
    expect(screen.queryByText('Today')).not.toBeInTheDocument();
    expect(screen.queryByText('Why this is in your plan')).not.toBeInTheDocument();
    expect(screen.getByText('How to do it')).toBeInTheDocument();
  });

  it('error: says the plan is unchanged, shows the reference, and retries', async () => {
    api.mockRejectedValueOnce(new ApiError(500, { error: { code: 'INTERNAL', message: 'x', requestId: 'req_ex' } }));
    renderExercise();
    expect(await screen.findByRole('heading', { name: 'Could not load this exercise' })).toBeInTheDocument();
    expect(screen.getByText('Ref req_ex')).toBeInTheDocument();
    api.mockResolvedValue(payload());
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Back squat' })).toBeInTheDocument();
  });
});
