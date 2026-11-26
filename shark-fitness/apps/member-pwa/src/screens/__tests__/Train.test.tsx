import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Viewer } from '@shark/contracts';

const api = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/api')>()), api }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  Link: ({ to, params, children, className }: { to: string; params?: Record<string, string>; children: React.ReactNode; className?: string }) => (
    <a href={Object.entries(params ?? {}).reduce((href, [key, value]) => href.replace(`$${key}`, value), to)} className={className}>
      {children}
    </a>
  ),
}));

import { ApiError, OfflineError } from '../../lib/api';
import TrainScreen from '../Train';
import { useSession } from '../../lib/store';

const viewer = {
  userId: 'usr_aman', tenantId: 'ten_shark', memberId: 'mbr_aman', staffId: null, name: 'Aman Mehta', initials: 'AM', email: null,
  role: 'member', accountState: 'active', homeBranchId: 'br_kor', permittedBranchIds: ['br_kor'], permissions: [],
  preferences: { register: 'plain', unitSystem: 'metric', theme: 'dark', haptics: true, reducedMotion: false },
} as Viewer;

const day = (dayIndex: number, dayName: string, overrides: Record<string, unknown> = {}) => ({
  dayIndex, dayName, date: `2026-11-${23 + dayIndex}`, programDayId: `pd_${dayIndex}`, label: 'Rest', focus: 'rest', isRest: true,
  estimatedMin: 0, exerciseCount: 0, setCount: 0, state: 'rest', isToday: false, past: dayIndex < 3, completed: null, ...overrides,
});

const item = (overrides: Record<string, unknown> = {}) => ({
  id: 'pit_1', orderIndex: 0, exerciseId: 'ex_squat', exerciseName: 'Back squat', equipment: 'barbell', primaryMuscles: ['quads'], muscleLabels: ['Quads'],
  usesBarbell: true, mediaUrl: null, archived: false, targetLabel: '4 × 5 @ RPE 8', sets: [], targetKg: 90, plateLabel: '20 + 15', restSec: 150,
  supersetGroup: null, tempo: null, notes: null, rationale: null, trainerLocked: false, allowedSubstitutionIds: [], substitutedFrom: null,
  lastPerformance: { weightKg: 87.5, reps: 5, at: '2026-11-23', atLabel: 'Mon', label: '87.5 kg × 5' },
  recovery: { muscle: 'quads', label: 'Quads', recoveredPct: 40, note: 'Still recovering.' }, adaptive: null,
  ...overrides,
});

/** GET /member/training/plan as routes/member/training.ts sends it. */
function payload(overrides: Record<string, unknown> = {}) {
  return {
    assignment: { id: 'asg_1', startsOn: '2026-11-09', currentWeek: 3, currentBlock: 'Strength', state: 'active', trainerName: 'Rehan Khan', programVersion: 2 },
    program: { id: 'prg_1', name: 'Foundations 5×5', version: 2, goal: 'strength', daysPerWeek: 3, weeks: 8, authorName: 'Rehan Khan', description: '' },
    week: {
      number: 3, of: 8, block: 'Strength', startsOn: '2026-11-23',
      days: [
        day(0, 'Mon', { label: 'Lower A', isRest: false, state: 'done', exerciseCount: 5, setCount: 18, completed: { clientId: 'w1', title: 'Lower A', volumeKg: 6400, totalSets: 18 } }),
        day(1, 'Tue'),
        day(3, 'Thu', { label: 'Upper A', focus: 'upper', isRest: false, state: 'today', isToday: true, past: false, exerciseCount: 2, setCount: 8, estimatedMin: 50 }),
        day(5, 'Sat', { label: 'Lower B', isRest: false, state: 'planned', past: false, exerciseCount: 4, setCount: 14 }),
      ],
      setsThisWeek: 18, setsLastWeek: 30, volumeWarning: null,
    },
    today: {
      programDayId: 'pd_3', date: '2026-11-26', label: 'Upper A', focus: 'upper', isRest: false, estimatedMin: 50, done: false,
      items: [item(), item({ id: 'pit_2', orderIndex: 1, exerciseId: 'ex_row', exerciseName: 'Barbell row', lastPerformance: null, recovery: null, trainerLocked: true, supersetGroup: 'A' })],
    },
    adaptive: null,
    explanation: {
      decisionId: null, headline: 'Nothing changed this week',
      body: 'Your recent sessions landed on target, so the prescription holds. Log RPE and the rules will adjust next week.',
      inputs: ['last 3 sessions per lift', 'logged RPE'], changes: [], confidence: 'medium',
      limitations: 'Estimates from what you logged. Tell your coach if anything hurts.', rulesVersion: 'r2026.11', reviewedByName: 'Rehan Khan',
      reviewedAt: null, reviewedLabel: null, memberDecision: 'accepted', decidable: false,
    },
    muscleSplit: [], injuryHold: null, resume: null,
    ...overrides,
  };
}

const pendingChange = {
  decisionId: 'adp_1', headline: 'Squat goes up 2.5 kg', body: 'You hit every rep at RPE 7 twice in a row.',
  inputs: ['last 3 sessions per lift', 'logged RPE'], changes: [{ exerciseName: 'Back squat', field: 'load', from: '87.5 kg', to: '90 kg' }],
  confidence: 'high', limitations: 'Estimates from what you logged.', rulesVersion: 'r2026.11', reviewedByName: 'Rehan Khan',
  reviewedAt: '2026-11-25T10:00:00Z', reviewedLabel: '1d', memberDecision: 'pending', decidable: true,
};

function renderTrain(client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })) {
  return render(
    <QueryClientProvider client={client}>
      <TrainScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => useSession.setState({ viewer, status: 'signed-in' } as never));
afterEach(() => {
  api.mockReset();
  navigate.mockReset();
});

describe('Train', () => {
  it('shows a loading skeleton first', () => {
    api.mockReturnValue(new Promise(() => undefined));
    const { container } = renderTrain();
    expect(container.querySelector('.sf-skeleton')).not.toBeNull();
  });

  it('renders the week and today’s exercises from the plan', async () => {
    api.mockResolvedValue(payload());
    renderTrain();
    expect(await screen.findByRole('heading', { level: 1, name: 'Foundations 5×5' })).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith('/member/training/plan');
    expect(screen.getByText('Rehan Khan · 3 days a week · week 3 of 8')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByText('Planned')).toBeInTheDocument();
    const squat = screen.getByText('Back squat').closest('a')!;
    expect(squat).toHaveAttribute('href', '/train/exercise/ex_squat');
    expect(squat).toHaveTextContent('4 × 5 @ RPE 8 · 90 kg');
    expect(squat).toHaveTextContent('87.5 kg × 5');
    expect(squat).toHaveTextContent('40%');
    const row = screen.getByText('Barbell row').closest('a')!;
    expect(row).toHaveTextContent('Locked');
    expect(row).toHaveTextContent('Superset A');
    expect(row).toHaveTextContent('First time');
  });

  it('starts today’s session or a session of your own', async () => {
    api.mockResolvedValue(payload());
    renderTrain();
    const starts = await screen.findAllByRole('button', { name: 'Start session' });
    fireEvent.click(starts.at(-1)!);
    expect(navigate).toHaveBeenCalledWith({ to: '/workout' });
    fireEvent.click(screen.getByRole('button', { name: 'Log a workout of your own' }));
    expect(navigate).toHaveBeenCalledWith({ to: '/workout', search: { mode: 'freestyle' } });
  });

  it('explains a live adjustment without offering a decision the server would refuse', async () => {
    api.mockResolvedValue(payload());
    renderTrain();
    expect(await screen.findByText('Nothing changed this week')).toBeInTheDocument();
    expect(screen.getByText(/Rule set r2026\.11\. Confidence medium\. Reviewed by Rehan Khan\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use it' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Keep the old load' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask coach' })).toBeInTheDocument();
  });

  it('a pending plan change can be accepted, with its receipt shown', async () => {
    api.mockImplementation(async (path: string) => (path.includes('/adaptive/') ? { ok: true } : payload({ explanation: pendingChange })));
    renderTrain();
    expect(await screen.findByText('Squat goes up 2.5 kg')).toBeInTheDocument();
    expect(screen.getByText('87.5 kg')).toBeInTheDocument();
    expect(screen.getByText('90 kg')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use it' }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/member/training/adaptive/adp_1/decision', { method: 'POST', body: { decision: 'accepted' } }),
    );
  });

  it('a refused decision says why', async () => {
    api.mockImplementation(async (path: string) => {
      if (path.includes('/adaptive/')) throw new ApiError(409, { error: { code: 'CONFLICT', message: 'You already declined this change.', requestId: 'r' } });
      return payload({ explanation: pendingChange });
    });
    renderTrain();
    fireEvent.click(await screen.findByRole('button', { name: 'Keep the old load' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You already declined this change.');
  });

  it('a big jump in volume is flagged plainly', async () => {
    api.mockResolvedValue(payload({ week: { ...payload().week, volumeWarning: 'That is a big step up from last week (10 to 18 sets).' } }));
    renderTrain();
    expect(await screen.findByText('Worth knowing')).toBeInTheDocument();
    expect(screen.getByText('That is a big step up from last week (10 to 18 sets).')).toBeInTheDocument();
  });

  it('rest day: says so and offers habits or a session of your own', async () => {
    api.mockResolvedValue(payload({ today: { ...payload().today, label: 'Rest', isRest: true, items: [] } }));
    renderTrain();
    expect(await screen.findByRole('heading', { name: 'Rest day' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: "Log today's habits" }).closest('a')).toHaveAttribute('href', '/habits');
    fireEvent.click(screen.getByRole('button', { name: 'Log a workout' }));
    expect(navigate).toHaveBeenCalledWith({ to: '/workout', search: { mode: 'freestyle' } });
  });

  it('empty: no plan assigned, with a way to ask for one or log anyway', async () => {
    api.mockResolvedValue({ ...payload(), assignment: null, program: null, today: null, explanation: null });
    renderTrain();
    expect(await screen.findByRole('heading', { name: 'No plan assigned yet' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask for a plan' }).closest('a')).toHaveAttribute('href', '/messages');
    fireEvent.click(screen.getByRole('button', { name: 'Log a workout' }));
    expect(navigate).toHaveBeenCalledWith({ to: '/workout', search: { mode: 'freestyle' } });
  });

  it('error with nothing saved: retries', async () => {
    api.mockRejectedValueOnce(new ApiError(500, { error: { code: 'INTERNAL', message: 'x', requestId: 'r' } }));
    renderTrain();
    expect(await screen.findByRole('heading', { name: 'Could not load your plan' })).toBeInTheDocument();
    api.mockResolvedValue(payload());
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Foundations 5×5' })).toBeInTheDocument();
  });

  it('offline with a saved plan: keeps showing it when the refresh fails', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['training', 'plan'], payload(), { updatedAt: Date.now() - 60 * 60 * 1000 });
    api.mockRejectedValue(new OfflineError());
    renderTrain(client);
    await waitFor(() => expect(client.getQueryState(['training', 'plan'])?.status).toBe('error'));
    expect(screen.getByRole('heading', { level: 1, name: 'Foundations 5×5' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Could not load your plan' })).not.toBeInTheDocument();
  });
});
