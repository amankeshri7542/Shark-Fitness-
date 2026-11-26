import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Viewer } from '@shark/contracts';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/api')>()), api }));
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ workoutId: 'wkt-client-1' }),
  Link: ({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

import { ApiError, OfflineError } from '../../lib/api';
import SummaryScreen from '../Summary';
import type { DoneSnapshot } from '../Workout';
import { useSession } from '../../lib/store';

const viewer = {
  userId: 'usr_aman', tenantId: 'ten_shark', memberId: 'mbr_aman', staffId: null, name: 'Aman Mehta', initials: 'AM', email: null,
  role: 'member', accountState: 'active', homeBranchId: 'br_kor', permittedBranchIds: ['br_kor'], permissions: [],
  preferences: { register: 'plain', unitSystem: 'metric', theme: 'dark', haptics: true, reducedMotion: false },
} as Viewer;

/** GET /member/training/workouts/:clientId → summary, as routes/member/training.ts sends it. */
function summary(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wkt_1',
    clientId: 'wkt-client-1',
    title: 'Upper A',
    state: 'completed',
    startedAt: '2026-11-26T06:00:00Z',
    finishedAt: '2026-11-26T06:52:00Z',
    durationSec: 3120,
    volumeKg: 5230,
    totalSets: 16,
    completedSets: 15,
    exerciseCount: 4,
    xpAwarded: 120,
    personalRecords: [
      { id: 'pr_1', exerciseId: 'ex_bench', exerciseName: 'Bench press', kind: 'weight', value: 72.5, display: '72.5 kg × 5', previousValue: 70, previousDisplay: '70 kg × 5', delta: '+2.5 kg', achievedAt: '2026-11-26T06:30:00Z', shared: false },
    ],
    muscleVolume: [{ muscle: 'chest', label: 'Chest', sets: 8, share: 53 }],
    volumeWarning: 'That is a big step up from last week (10 to 26 sets). Increases above about 20% a week tend to cost more than they give.',
    coachNote: null,
    sessionRpe: 8,
    notes: 'Shoulder felt fine.',
    substitutions: [],
    byExercise: [
      { exerciseId: 'ex_bench', exerciseName: 'Bench press', sets: 5, topSetKg: 72.5, topSetReps: 5, volumeKg: 1700, estimated1rm: 84.6 },
    ],
    ...overrides,
  };
}

const snapshot: DoneSnapshot = {
  clientId: 'wkt-client-1',
  title: 'Upper A',
  startedAt: '2026-11-26T06:00:00Z',
  finishedAt: '2026-11-26T06:50:00Z',
  durationSec: 3000,
  volumeKg: 4100,
  totalSets: 16,
  completedSets: 12,
  exerciseCount: 4,
  sessionRpe: null,
  muscleVolume: [{ muscle: 'chest', label: 'Chest', sets: 6, share: 50 }],
};

function renderSummary() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SummaryScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  useSession.setState({ viewer, status: 'signed-in' } as never);
});
afterEach(() => {
  api.mockReset();
  delete (navigator as { share?: unknown }).share;
});

describe('Summary', () => {
  it('shows a loading skeleton first, with Done to leave', () => {
    api.mockReturnValue(new Promise(() => undefined));
    const { container } = renderSummary();
    expect(container.querySelector('.sf-skeleton')).not.toBeNull();
    expect(screen.getByRole('link', { name: 'Done' })).toHaveAttribute('href', '/');
  });

  it('renders the synced session: numbers, the record, the load check and the breakdown', async () => {
    api.mockResolvedValue({ workout: {}, summary: summary() });
    renderSummary();
    expect(await screen.findByRole('heading', { level: 1, name: 'Upper A' })).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith('/member/training/workouts/wkt-client-1');
    expect(screen.getByText('52m')).toBeInTheDocument();
    expect(screen.getByText('5230')).toBeInTheDocument();
    expect(screen.getByText('+120 XP')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Bench press' })).toBeInTheDocument();
    // The server's safety sentence, shown as sent.
    expect(screen.getByText('Load check')).toBeInTheDocument();
    expect(screen.getByText(/That is a big step up from last week \(10 to 26 sets\)/)).toBeInTheDocument();
    expect(screen.getByText('5 sets · top 72.5 kg × 5')).toBeInTheDocument();
    expect(screen.getByText('Shoulder felt fine.')).toBeInTheDocument();
    expect(screen.queryByText('Not synced yet')).not.toBeInTheDocument();
  });

  it('a record buzzes once per session, not on every visit', async () => {
    const vibrate = vi.fn(() => true);
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: vibrate });
    try {
      api.mockResolvedValue({ workout: {}, summary: summary() });
      const first = renderSummary();
      await screen.findByRole('heading', { name: 'Bench press' });
      await waitFor(() => expect(vibrate).toHaveBeenCalledTimes(1));
      first.unmount();
      renderSummary();
      await screen.findByRole('heading', { name: 'Bench press' });
      expect(vibrate).toHaveBeenCalledTimes(1);
    } finally {
      delete (navigator as { vibrate?: unknown }).vibrate;
    }
  });

  it('shares the session only, where the phone can share', async () => {
    const share = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'share', { configurable: true, value: share });
    api.mockResolvedValue({ workout: {}, summary: summary() });
    renderSummary();
    fireEvent.click(await screen.findByRole('button', { name: 'Share' }));
    expect(share).toHaveBeenCalledWith({ title: 'Shark Fitness', text: 'Upper A: 5,230 kg moved in 52m. Logged with Shark Fitness.' });
  });

  it('offline right after finishing: the numbers from this phone, marked not synced yet', async () => {
    localStorage.setItem('shark.workout.done.wkt-client-1', JSON.stringify(snapshot));
    api.mockRejectedValue(new OfflineError());
    renderSummary();
    expect(await screen.findByText('Not synced yet')).toBeInTheDocument();
    expect(screen.getByText(/The session is queued and uploads on its own/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Upper A' })).toBeInTheDocument();
    expect(screen.getByText('50m')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Could not load this session' })).not.toBeInTheDocument();
  });

  it('error with nothing on this phone: says it may still be uploading, and retries', async () => {
    api.mockRejectedValueOnce(new ApiError(404, { error: { code: 'NOT_FOUND', message: 'That session was not found.', requestId: 'req_sum' } }));
    renderSummary();
    expect(await screen.findByRole('heading', { name: 'Could not load this session' })).toBeInTheDocument();
    expect(screen.getByText('Ref req_sum')).toBeInTheDocument();
    api.mockResolvedValue({ workout: {}, summary: summary() });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Upper A' })).toBeInTheDocument();
  });
});
