import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Viewer } from '@shark/contracts';

const api = vi.hoisted(() => vi.fn());
const enqueue = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/api')>()), api }));
vi.mock('../../lib/outbox', () => ({ enqueue }));

import { ApiError } from '../../lib/api';
import HabitsScreen from '../Habits';
import { useSession } from '../../lib/store';

const viewer = {
  userId: 'usr_aman', tenantId: 'ten_shark', memberId: 'mbr_aman', staffId: null, name: 'Aman Mehta', initials: 'AM', email: null,
  role: 'member', accountState: 'active', homeBranchId: 'br_kor', permittedBranchIds: ['br_kor'], permissions: [],
  preferences: { register: 'plain', unitSystem: 'metric', theme: 'dark', haptics: true, reducedMotion: false },
} as Viewer;

const week = (doneDays: number) =>
  ['Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu'].map((label, i) => ({ date: `2026-11-${20 + i}`, label, done: i < doneDays, value: i < doneDays ? 1 : 0 }));

const habit = (overrides: Record<string, unknown> = {}) => ({
  id: 'hab_stretch', name: 'Stretch 10 minutes', icon: '◆', cadence: 'daily', target: 1, unit: 'session', active: true,
  todayValue: 0, done: false, streakDays: 4, longestStreak: 9, last7Days: week(4), ...overrides,
});

/** GET /member/habits as routes/member/habits.ts sends it. */
function payload(overrides: Record<string, unknown> = {}) {
  return {
    today: { date: '2026-11-26', label: 'Thursday 26 November' },
    optedOut: false,
    habits: [habit(), habit({ id: 'hab_steps', name: 'Walk', target: 8, unit: 'thousand steps', todayValue: 3, streakDays: 0, last7Days: week(0) })],
    summary: { total: 2, doneToday: 0, bestStreak: 4 },
    metrics: { waterMl: 1500, waterTargetMl: 3000, sleepMin: null, steps: null, mood: null, energy: null, soreness: null, logged: true },
    nutrition: { enabled: true, kcal: 2400, proteinG: 150, waterTargetMl: 3000, setByName: 'Rehan Khan', disclaimer: 'General guidance, not medical advice. Speak to a doctor about any condition.' },
    coach: { name: 'Rehan Khan' },
    ...overrides,
  };
}

const checkIn = {
  optedOut: false, weekStart: '2026-11-23', weekLabel: '23 Nov – 29 Nov',
  scales: [{ key: 'energy', label: 'Energy', low: 'Low', high: 'High' }],
  checkIn: null, coach: { name: 'Rehan Khan' }, privacyNote: 'Your coach (Rehan Khan) reads this.',
};

function serve(habits: () => unknown = () => payload()) {
  api.mockImplementation(async (path: string) => {
    if (path === '/member/habits') return habits();
    if (path === '/member/habits/check-in') return checkIn;
    throw new Error(`Unexpected ${path}`);
  });
}

function renderHabits() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <HabitsScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useSession.setState({ viewer, status: 'signed-in' } as never);
  enqueue.mockResolvedValue(undefined);
});
afterEach(() => {
  api.mockReset();
  enqueue.mockReset();
});

describe('Habits', () => {
  it('shows a loading skeleton first', () => {
    api.mockReturnValue(new Promise(() => undefined));
    const { container } = renderHabits();
    expect(container.querySelector('.sf-skeleton')).not.toBeNull();
  });

  it('renders today’s habits, water and the nutrition targets with their disclaimer verbatim', async () => {
    serve();
    renderHabits();
    expect(await screen.findByRole('heading', { level: 1, name: '0 of 2 done' })).toBeInTheDocument();
    expect(screen.getByText('Thursday 26 November')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Stretch 10 minutes' })).toBeInTheDocument();
    expect(screen.getByText('4d')).toBeInTheDocument();
    expect(screen.getByText('3 / 8 thousand steps')).toBeInTheDocument();
    expect(screen.getByText('1.5 of 3.0 L')).toBeInTheDocument();
    expect(screen.getByText('2400')).toBeInTheDocument();
    expect(screen.getByText('Set by Rehan Khan')).toBeInTheDocument();
    expect(screen.getByText('General guidance, not medical advice. Speak to a doctor about any condition.')).toBeInTheDocument();
    // The weekly check-in sits underneath.
    expect(await screen.findByText('Your coach (Rehan Khan) reads this.')).toBeInTheDocument();
  });

  it('ticking a habit lands at once and goes through the offline outbox, keyed for a safe retry', async () => {
    serve();
    // The outbox has not answered (dead network): the tick still shows.
    enqueue.mockReturnValue(new Promise(() => undefined));
    renderHabits();
    fireEvent.click(await screen.findByRole('button', { name: 'Mark done' }));
    expect(screen.getByRole('button', { name: 'Done — undo' })).toHaveAttribute('aria-pressed', 'true');
    expect(enqueue).toHaveBeenCalledWith({
      clientId: 'habit:hab_stretch:2026-11-26:1',
      kind: 'habit-log',
      method: 'POST',
      path: '/member/habits/log',
      body: { habitId: 'hab_stretch', onDate: '2026-11-26', value: 1, clientId: 'habit:hab_stretch:2026-11-26:1' },
    });
    // No direct write to the server from the screen.
    expect(api.mock.calls.some(([path]) => path === '/member/habits/log')).toBe(false);
  });

  it('counts a multi-step habit up and down, and adds water by the glass', async () => {
    serve();
    renderHabits();
    const walk = (await screen.findByRole('heading', { name: 'Walk' })).closest('div.border') as HTMLElement;
    fireEvent.click(within(walk).getByRole('button', { name: '+1' }));
    expect(within(walk).getByText('4 / 8 thousand steps')).toBeInTheDocument();
    fireEvent.click(within(walk).getByRole('button', { name: '−1' }));
    expect(within(walk).getByText('3 / 8 thousand steps')).toBeInTheDocument();
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'habit-log', body: expect.objectContaining({ habitId: 'hab_steps', value: 3 }) }));

    fireEvent.click(screen.getByRole('button', { name: '+ glass' }));
    expect(screen.getByText('1.8 of 3.0 L')).toBeInTheDocument();
    expect(enqueue).toHaveBeenLastCalledWith({
      clientId: 'metrics:2026-11-26:water:1750',
      kind: 'habit-metrics',
      method: 'POST',
      path: '/member/habits/metrics',
      body: { onDate: '2026-11-26', waterMl: 1750, source: 'manual' },
    });
    // Once queued, the screen asks for the server's view again.
    await waitFor(() => expect(api.mock.calls.filter(([path]) => path === '/member/habits').length).toBeGreaterThan(1));
  });

  it('opted out: says habits are off and how to turn them back on', async () => {
    serve(() => payload({ optedOut: true }));
    renderHabits();
    expect(await screen.findByRole('heading', { name: 'Habits are switched off' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark done' })).not.toBeInTheDocument();
  });

  it('empty: no habits yet, water still works, nutrition hidden when off', async () => {
    serve(() => payload({ habits: [], summary: { total: 0, doneToday: 0, bestStreak: 0 }, nutrition: { ...payload().nutrition, enabled: false } }));
    renderHabits();
    expect(await screen.findByRole('heading', { name: 'No habits yet' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ glass' })).toBeInTheDocument();
    expect(screen.queryByText('Nutrition')).not.toBeInTheDocument();
  });

  it('error: says offline ticks are still queued, and retries', async () => {
    let calls = 0;
    serve(() => {
      if (calls++ === 0) throw new ApiError(500, { error: { code: 'INTERNAL', message: 'x', requestId: 'req_hab' } });
      return payload();
    });
    renderHabits();
    expect(await screen.findByRole('heading', { name: 'Could not load your habits' })).toBeInTheDocument();
    expect(screen.getByText(/still queued and will sync/)).toBeInTheDocument();
    expect(screen.getByText('Ref req_hab')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 1, name: '0 of 2 done' })).toBeInTheDocument();
  });
});
