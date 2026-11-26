import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Viewer } from '@shark/contracts';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/api')>()), api, API_ORIGIN: '' }));

import { ApiError } from '../../lib/api';
import ProgressScreen from '../Progress';
import { useSession } from '../../lib/store';

const viewer = {
  userId: 'usr_aman', tenantId: 'ten_shark', memberId: 'mbr_aman', staffId: null, name: 'Aman Mehta', initials: 'AM', email: null,
  role: 'member', accountState: 'active', homeBranchId: 'br_kor', permittedBranchIds: ['br_kor'], permissions: [],
  preferences: { register: 'plain', unitSystem: 'metric', theme: 'dark', haptics: true, reducedMotion: false },
} as Viewer;

/** GET /member/progress as routes/member/progress.ts sends it. */
function progress(overrides: Record<string, unknown> = {}) {
  return {
    rangeWeeks: 8,
    unitSystem: 'metric',
    branchName: 'Koramangala Depot',
    generatedAt: '2026-11-26T08:00:00Z',
    tonnageChangePct: 12,
    adherencePct: 83,
    newPrCount: 2,
    weeklyTonnage: [
      { label: 'W40', value: 5200, estimated: false },
      { label: 'W41', value: 6100, estimated: false },
      { label: 'W42', value: 6400, estimated: false },
    ],
    attendance: [
      { label: 'W40', sessions: 3, planned: 3, branchClosed: false },
      { label: 'W41', sessions: 0, planned: 3, branchClosed: true },
      { label: 'W42', sessions: 2, planned: 3, branchClosed: false },
    ],
    averageSessionsPerWeek: 2.5,
    weeklyTarget: 3,
    latestMeasurement: { takenOn: '2026-11-20', weightKg: 78.4, bodyFatPct: 18.2, leanMassKg: 64.1 },
    measurementTrend: [],
    bodyComposition: {
      takenOn: '2026-11-20',
      source: 'inbody',
      outlier: false,
      comparedWith: '2026-10-20',
      items: [
        { key: 'weightKg', label: 'Weight', value: 78.4, unit: 'kg', delta: -1.2, lowerIsBetter: false },
        { key: 'bodyFatPct', label: 'Body fat', value: 18.2, unit: '%', delta: -0.8, lowerIsBetter: true, improving: true },
        { key: 'leanMassKg', label: 'Lean mass', value: 64.1, unit: 'kg', delta: 0.4, lowerIsBetter: false, improving: true },
      ],
    },
    goals: [
      { id: 'gol_1', title: 'Squat 100 kg', current: 90, target: 100, unit: 'kg', targetDate: '2027-01-31', progressPct: 70, onTrack: false, paceWarning: 'At this pace you reach it in March.' },
    ],
    strengthOptions: [],
    insufficientData: null,
    estimateNote: 'Tonnage, adherence and body composition come from what you logged. They are a record of your input, not a measurement of your body.',
    ...overrides,
  };
}

const recovery = {
  estimate: true,
  computedAt: '2026-11-26T08:00:00Z',
  disclaimer: 'An estimate.',
  regions: [
    { muscle: 'chest', label: 'Chest', side: 'front', recoveredPct: 64, lastWorkedAt: '2026-11-25T08:00:00Z', lastWorkedLabel: '1d', setsLast7d: 12, note: 'Recovering. Light pressing is fine.' },
    { muscle: 'quads', label: 'Quads', side: 'front', recoveredPct: 92, lastWorkedAt: '2026-11-23T08:00:00Z', lastWorkedLabel: '3d', setsLast7d: 8, note: 'Ready.' },
  ],
  trainedCount: 2,
  summary: 'Chest is the least recovered at about 64%.',
};

const records = {
  items: [
    { id: 'pr_1', exerciseId: 'ex_squat', exerciseName: 'Back squat', kind: 'weight', value: 90, display: '90 kg × 5', previousValue: 87.5, previousDisplay: '87.5 kg × 5', delta: '+2.5 kg', improved: true, achievedAt: '2026-11-23T08:00:00Z', achievedLabel: '3d', isNew: true, shared: false },
  ],
  total: 1,
  newInLast30: 1,
};

const photos = (granted = true) => ({
  consent: { granted, version: granted ? '2.0' : null, current: granted, currentVersion: '2.0', text: 'Shark Fitness stores the progress photos you upload so you can compare them over time.' },
  retentionDays: 30,
  items: [],
});

type Routes = Record<string, () => unknown>;
function serve(routes: Partial<Routes> = {}) {
  const table: Routes = {
    '/member/progress': () => progress(),
    '/member/progress/recovery': () => recovery,
    '/member/progress/records': () => records,
    '/member/progress/photos': () => photos(),
    ...routes,
  } as Routes;
  api.mockImplementation(async (path: string) => {
    const handler = table[path];
    if (!handler) throw new Error(`Unexpected ${path}`);
    return handler();
  });
}

function renderProgress() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <ProgressScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => useSession.setState({ viewer, status: 'signed-in' } as never));
afterEach(() => api.mockReset());

const fail = (requestId = 'r') => {
  throw new ApiError(500, { error: { code: 'INTERNAL', message: 'x', requestId } });
};

describe('Progress', () => {
  it('shows a loading skeleton first', () => {
    api.mockReturnValue(new Promise(() => undefined));
    const { container } = renderProgress();
    expect(container.querySelector('.sf-skeleton')).not.toBeNull();
  });

  it('renders the trend, recovery map, records, attendance, body composition and goals', async () => {
    serve();
    renderProgress();
    expect(await screen.findByRole('heading', { level: 1, name: 'Your progress' })).toBeInTheDocument();
    expect(screen.getByText('+12%')).toBeInTheDocument();
    expect(screen.getByText('83%')).toBeInTheDocument();
    expect(await screen.findByText('Back squat')).toBeInTheDocument();
    expect(screen.getByText('90 kg × 5')).toBeInTheDocument();
    expect(screen.getByText('+2.5 kg')).toBeInTheDocument();
    expect(screen.getByText(/Dashed weeks are when the gym was shut/)).toBeInTheDocument();
    expect(screen.getByText('Body composition · 2026-11-20')).toBeInTheDocument();
    expect(screen.getByText('−0.8 %')).toBeInTheDocument();
    expect(screen.getByText('Squat 100 kg')).toBeInTheDocument();
    expect(screen.getByText('Behind')).toBeInTheDocument();
    expect(screen.getByText('At this pace you reach it in March.')).toBeInTheDocument();
    // Chest is selected by default; tapping another region shows its reading.
    expect(await screen.findByText('Recovering. Light pressing is fine.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Quads, 92% recovered' }));
    expect(screen.getByText('Ready.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Quads, 92% recovered' })).toHaveAttribute('aria-pressed', 'true');
    // A region with nothing logged cannot be selected.
    expect(screen.getByRole('button', { name: 'lats' })).toBeDisabled();
  });

  it('too little logged: says so instead of drawing a trend', async () => {
    serve({ '/member/progress': () => progress({ insufficientData: 'No sessions logged in the last 8 weeks, so there is no trend to draw yet. Log a session and this fills in.' }) });
    renderProgress();
    expect(await screen.findByRole('heading', { name: 'Not enough logged yet' })).toBeInTheDocument();
    expect(screen.getByText(/no trend to draw yet/)).toBeInTheDocument();
    expect(screen.queryByText('Recovery map')).not.toBeInTheDocument();
  });

  it('empty records and goals: invitations, not blanks', async () => {
    serve({ '/member/progress': () => progress({ goals: [] }), '/member/progress/records': () => ({ items: [], total: 0, newInLast30: 0 }) });
    renderProgress();
    expect(await screen.findByRole('heading', { name: 'No records yet' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'No goals set' })).toBeInTheDocument();
  });

  it('records that fail to load say so with a retry, never "No records yet"', async () => {
    let calls = 0;
    serve({ '/member/progress/records': () => (calls++ === 0 ? fail() : records) });
    renderProgress();
    expect(await screen.findByRole('heading', { name: 'Could not load your records' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'No records yet' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Back squat')).toBeInTheDocument();
  });

  it('a recovery estimate that fails to load says so, never "No sets logged yet"', async () => {
    let calls = 0;
    serve({ '/member/progress/recovery': () => (calls++ === 0 ? fail() : recovery) });
    renderProgress();
    expect(await screen.findByText('Could not load the recovery estimate.')).toBeInTheDocument();
    expect(screen.queryByText('No sets logged yet.')).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0]!);
    expect(await screen.findByText('Recovering. Light pressing is fine.')).toBeInTheDocument();
  });

  it('photos without consent: asks first, offers no upload (consent state)', async () => {
    serve({ '/member/progress/photos': () => photos(false) });
    renderProgress();
    expect(await screen.findByText('Before you add photos')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a photo' })).not.toBeInTheDocument();
  });

  it('error: says logged sessions are safe, and retries', async () => {
    let calls = 0;
    serve({ '/member/progress': () => (calls++ === 0 ? fail() : progress()) });
    renderProgress();
    expect(await screen.findByRole('heading', { name: 'Could not load your progress' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Your progress' })).toBeInTheDocument());
  });
});
