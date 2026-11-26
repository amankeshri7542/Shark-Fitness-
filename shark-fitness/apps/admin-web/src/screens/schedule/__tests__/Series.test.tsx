import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/api')>();
  return { ...actual, api: apiMock };
});

import { ApiError } from '../../../lib/api';
import { refuse, signInAs } from '../../../test/harness';
import { renderPanel } from '../../store/__tests__/harness';
import SeriesSurface from '../Series';

/* Recurring classes (PF-SCH). Fixtures follow `listSeries` / `seriesDetail`
   in apps/api/src/services/schedule-series.ts. */

const spin = {
  id: 'ser_spin',
  branchId: 'br_kor',
  className: 'Spin',
  roomName: 'Cycle Studio',
  trainerId: 'stf_nikhil',
  weekdays: [1, 3],
  weekdayLabel: 'Tue, Thu',
  interval: 1,
  startTime: '18:30',
  durationMin: 45,
  capacity: 16,
  startDate: '2026-11-03',
  endDate: null,
  occurrenceCount: null,
  state: 'active',
  generatedThrough: '2027-01-21',
  supersedesSeriesId: null,
  supersededBySeriesId: null,
  upcoming: 16,
};

const resources = {
  classTypes: [{ id: 'ct_spin', name: 'Spin', durationMin: 45 }, { id: 'ct_yoga', name: 'Yoga', durationMin: 60 }],
  rooms: [{ id: 'rm_cycle', name: 'Cycle Studio', branchId: 'br_kor', capacity: 16 }],
  trainers: [{ id: 'stf_nikhil', name: 'Nikhil Rao', branchIds: ['br_kor'] }],
  branches: [{ id: 'br_kor', name: 'Koramangala' }],
};

const detail = {
  series: { ...spin, notes: null },
  weekdayLabel: 'Tue, Thu',
  occurrences: [
    { id: 'ses_past', occurrenceDate: '2026-11-24', startsAt: Date.parse('2026-11-24T13:00:00Z'), state: 'completed', capacity: 16, booked: 12, cancelledReason: null, past: true, edited: false },
    { id: 'ses_next', occurrenceDate: '2026-11-26', startsAt: Date.parse('2026-11-26T13:00:00Z'), state: 'scheduled', capacity: 16, booked: 9, cancelledReason: null, past: false, edited: false },
    { id: 'ses_later', occurrenceDate: '2026-12-01', startsAt: Date.parse('2026-12-01T13:00:00Z'), state: 'scheduled', capacity: 16, booked: 0, cancelledReason: null, past: false, edited: true },
  ],
};

type Handler = (options?: { method?: string; body?: unknown }) => unknown;

function routeApi(overrides: Record<string, Handler> = {}) {
  const routes: Record<string, Handler> = {
    '/admin/schedule/series': () => ({ series: [spin] }),
    '/admin/schedule/resources': () => resources,
    '/admin/schedule/series/ser_spin': () => detail,
    ...overrides,
  };
  apiMock.mockImplementation((path: string, options?: { method?: string; body?: unknown }) => {
    const handler = routes[path] ?? routes[path.split('?')[0]!];
    if (!handler) throw new Error(`Unexpected API call: ${path}`);
    return Promise.resolve().then(() => handler(options));
  });
}

beforeEach(() => {
  apiMock.mockReset();
  signInAs('branch_manager');
  routeApi();
});

describe('Series', () => {
  it('shows a permission state, and reads nothing, for a role without the schedule', () => {
    signInAs('accountant');
    renderPanel(<SeriesSurface />);
    expect(screen.getByText('Not available to your role')).toBeInTheDocument();
    expect(screen.getByText(/The timetable is restricted/)).toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('holds the list back while it loads', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    routeApi({ '/admin/schedule/series': () => new Promise((r) => (resolve = r)) });
    renderPanel(<SeriesSurface />);
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/admin/schedule/series?includeEnded=false', { branchId: 'br_kor' }));
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText('No recurring classes')).toBeNull();
    resolve({ series: [spin] });
    expect(await screen.findByRole('table', { name: 'Recurring classes' })).toBeInTheDocument();
  });

  it('says the timetable could not be read, with the server reason, and retries', async () => {
    const user = userEvent.setup();
    routeApi({
      '/admin/schedule/series': () =>
        refuse(new ApiError(404, { error: { code: 'NOT_FOUND', message: 'That branch was not found.', requestId: 'req_series' } })),
    });
    renderPanel(<SeriesSurface />);
    expect(await screen.findByRole('heading', { name: 'The timetable could not be read' })).toBeInTheDocument();
    expect(screen.getByText('That branch was not found.')).toBeInTheDocument();
    expect(screen.getByText('Ref req_series')).toBeInTheDocument();
    routeApi();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table', { name: 'Recurring classes' })).toBeInTheDocument();
  });

  it('says there are no recurring classes and offers to state one', async () => {
    routeApi({ '/admin/schedule/series': () => ({ series: [] }) });
    renderPanel(<SeriesSurface />);
    expect(await screen.findByRole('heading', { name: 'No recurring classes' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'New recurring class' })).toHaveLength(2);
  });

  it('lists each rule, and shows ended ones on request', async () => {
    const user = userEvent.setup();
    renderPanel(<SeriesSurface />);
    const table = await screen.findByRole('table', { name: 'Recurring classes' });
    const [, row] = within(table).getAllByRole('row');
    expect(within(row!).getByText('Spin')).toBeInTheDocument();
    expect(within(row!).getByText('Tue, Thu')).toBeInTheDocument();
    expect(within(row!).getByText('Cycle Studio')).toBeInTheDocument();
    expect(within(row!).getByText('2026-11-03 → open')).toBeInTheDocument();
    expect(within(row!).getByText('active')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Show ended and cancelled'));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/admin/schedule/series?includeEnded=true', { branchId: 'br_kor' }));
  });

  it('opens a rule with its occurrences and what an edit leaves alone', async () => {
    const user = userEvent.setup();
    renderPanel(<SeriesSurface />);
    await user.click(await screen.findByRole('button', { name: 'Open' }));
    const panel = await screen.findByRole('region', { name: 'Spin · Tue, Thu at 18:30' });
    const occurrences = within(panel).getByRole('table', { name: 'Occurrences' });
    expect(within(occurrences).getByText('Already run — never changed by an edit')).toBeInTheDocument();
    expect(within(occurrences).getByText('Changed on its own, away from the rule')).toBeInTheDocument();
    expect(within(panel).getByText('2026-11-03 → until cancelled')).toBeInTheDocument();
  });

  it('says a rule could not be read, and retries', async () => {
    const user = userEvent.setup();
    routeApi({ '/admin/schedule/series/ser_spin': () => refuse(new Error('down')) });
    renderPanel(<SeriesSurface />);
    await user.click(await screen.findByRole('button', { name: 'Open' }));
    expect(await screen.findByRole('heading', { name: 'That recurring class could not be read' })).toBeInTheDocument();
    routeApi();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table', { name: 'Occurrences' })).toBeInTheDocument();
  });

  it('creates a rule and names the weeks it skipped', async () => {
    const user = userEvent.setup();
    routeApi({
      '/admin/schedule/series': (options) =>
        options?.method === 'POST'
          ? {
              series: { id: 'ser_new' },
              generation: {
                created: ['ses_a', 'ses_b'],
                skippedExisting: [],
                skippedConflict: [{ date: '2026-12-08', reason: 'Cycle Studio is booked' }],
                skippedPast: [],
                generatedThrough: '2027-01-19',
              },
            }
          : { series: [spin] },
    });
    renderPanel(<SeriesSurface />);
    await user.click(await screen.findByRole('button', { name: 'New recurring class' }));
    const form = screen.getByRole('region', { name: 'New recurring class' });
    await user.selectOptions(within(form).getByLabelText('Room'), 'rm_cycle');
    await user.selectOptions(within(form).getByLabelText('Coach'), 'stf_nikhil');
    await user.click(within(form).getByRole('button', { name: 'Tue' }));
    expect(within(form).getByRole('button', { name: 'Mon' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(form).getByRole('button', { name: 'Tue' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(form).getByRole('button', { name: 'Create and generate' }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/admin/schedule/series',
        expect.objectContaining({
          method: 'POST',
          branchId: 'br_kor',
          idempotencyKey: expect.any(String),
          body: expect.objectContaining({ classTypeId: 'ct_spin', roomId: 'rm_cycle', trainerId: 'stf_nikhil', weekdays: [0, 1], interval: 1, endDate: null, occurrenceCount: null }),
        }),
      ),
    );
    expect(await screen.findByText(/2 classes scheduled through 2027-01-19\./)).toBeInTheDocument();
    expect(screen.getByText(/Skipped 2026-12-08 \(Cycle Studio is booked\)/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'New recurring class' })).toBeNull();
  });

  it('lets a trainer read rules but not create or cancel them', async () => {
    const user = userEvent.setup();
    signInAs('trainer');
    renderPanel(<SeriesSurface />);
    await screen.findByRole('table', { name: 'Recurring classes' });
    expect(screen.queryByRole('button', { name: 'New recurring class' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await screen.findByRole('table', { name: 'Occurrences' });
    expect(screen.queryByRole('button', { name: 'Cancel classes' })).toBeNull();
  });
});
