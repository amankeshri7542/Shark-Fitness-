import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, api: apiMock };
});

import { ApiError } from '../../lib/api';
import ScheduleScreen from '../Schedule';
import { refuse, renderScreen, signInAs } from '../../test/harness';

/* The Schedule day grid and its tab shell (UX-A09). Fixtures follow the
   `/admin/schedule` handlers in apps/api/src/routes/admin/schedule.ts. The
   Recurring surface has its own test in screens/schedule/__tests__. */

const session = {
  id: 'ses_1',
  branchId: 'br_kor',
  branchName: 'Koramangala',
  name: 'Morning HIIT',
  category: 'hiit',
  roomName: 'Studio A',
  trainerId: 'stf_rehan',
  trainerName: 'Rehan Ahmed',
  startsAt: '2026-11-26T01:30:00.000Z',
  localTime: '07:00',
  localEndTime: '07:45',
  durationMin: 45,
  capacity: 20,
  booked: 18,
  seatsLeft: 2,
  fillPct: 90,
  waitlistCount: 0,
  state: 'scheduled',
  cancelledReason: null,
  substituted: false,
  creditsRequired: 1,
  version: 1,
  started: false,
};

const cancelled = {
  ...session,
  id: 'ses_2',
  name: 'Evening Yoga',
  localTime: '19:00',
  state: 'cancelled',
  cancelledReason: 'Studio floor being resurfaced',
  booked: 0,
  seatsLeft: 20,
  fillPct: 0,
};

const days = [
  { date: '2026-11-26', weekday: 'Thu', dayNo: 26, isToday: true },
  { date: '2026-11-27', weekday: 'Fri', dayNo: 27, isToday: false },
  { date: '2026-11-28', weekday: 'Sat', dayNo: 28, isToday: false },
];

function dayPayload(overrides: Record<string, unknown> = {}) {
  return {
    date: '2026-11-26',
    today: '2026-11-26',
    timezone: 'Asia/Kolkata',
    dateLabel: 'Thursday 26 November',
    days,
    totals: { sessions: 1, seats: 20, booked: 18, waitlisted: 0, cancelled: 1 },
    items: [session, cancelled],
    ...overrides,
  };
}

const detail = {
  session: { ...session, notes: null, seriesId: null, waitlistEnabled: true, timezone: 'Asia/Kolkata' },
  counts: { live: 1, attended: 0, noShow: 0, cancelled: 0, waitlisted: 1 },
  roster: [{ bookingId: 'bkg_1', memberId: 'mbr_1', memberNo: 'SF-1001', name: 'Asha Iyer', initials: 'AI', state: 'confirmed', seatNo: 4, cameFromWaitlist: false }],
  waitlist: [{ waitlistId: 'wl_1', memberId: 'mbr_2', memberNo: 'SF-1002', name: 'Ravi Shah', initials: 'RS', position: 1, state: 'waiting', offerExpiresAt: null }],
};

type Handler = (options?: { method?: string; body?: unknown }) => unknown;

function routeApi(overrides: Record<string, Handler> = {}) {
  const routes: Record<string, Handler> = {
    '/admin/schedule': () => dayPayload(),
    '/admin/schedule/resources': () => ({ classTypes: [], rooms: [], trainers: [{ id: 'stf_rehan', name: 'Rehan Ahmed' }, { id: 'stf_nikhil', name: 'Nikhil Rao' }], branches: [] }),
    '/admin/schedule/session/ses_1': () => detail,
    ...overrides,
  };
  apiMock.mockImplementation((path: string, options?: { method?: string; body?: unknown }) => {
    const handler = routes[path] ?? routes[path.split('?')[0]!];
    if (!handler) throw new Error(`Unexpected API call: ${path}`);
    return Promise.resolve().then(() => handler(options));
  });
}

const screens = [
  {
    path: '/schedule',
    component: ScheduleScreen,
    validateSearch: (s: Record<string, unknown>) => ({ tab: s.tab === 'series' ? 'series' : 'day' }),
  },
];

beforeEach(() => {
  apiMock.mockReset();
  signInAs('branch_manager');
  routeApi();
});

describe('Schedule', () => {
  it('shows a permission state, and reads nothing, for a role without the schedule', async () => {
    signInAs('accountant');
    renderScreen('/schedule', screens);
    expect(await screen.findByText('Not available to your role')).toBeInTheDocument();
    expect(screen.getByText(/The class schedule is restricted/)).toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('shows a loading page, then the day', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    apiMock.mockReturnValue(new Promise((r) => (resolve = r)));
    renderScreen('/schedule', screens);
    expect(await screen.findByText('Loading')).toBeInTheDocument();
    resolve(dayPayload());
    expect(await screen.findByText('Koramangala · Thursday 26 November')).toBeInTheDocument();
  });

  it('says the timetable could not load, with a reference, and retries', async () => {
    const user = userEvent.setup();
    routeApi({ '/admin/schedule': () => refuse(new ApiError(500, { error: { code: 'INTERNAL', message: 'boom', requestId: 'req_sched' } })) });
    renderScreen('/schedule', screens);
    expect(await screen.findByRole('heading', { name: 'Could not load the timetable' })).toBeInTheDocument();
    expect(screen.getByText('Ref req_sched')).toBeInTheDocument();
    routeApi();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Morning HIIT')).toBeInTheDocument();
  });

  it('says there are no classes on a day', async () => {
    routeApi({ '/admin/schedule': () => dayPayload({ items: [], totals: { sessions: 0, seats: 0, booked: 0, waitlisted: 0, cancelled: 0 } }) });
    renderScreen('/schedule', screens);
    expect(await screen.findByRole('heading', { name: 'No classes on this day' })).toBeInTheDocument();
  });

  it('does not print "undefined" when no branch is in scope', async () => {
    // The API's answer for an empty scope carries no date or label.
    routeApi({ '/admin/schedule': () => ({ date: null, days: [], items: [], totals: { sessions: 0, seats: 0, booked: 0, waitlisted: 0 } }) });
    renderScreen('/schedule', screens);
    expect(await screen.findByRole('heading', { name: 'No classes on this day' })).toBeInTheDocument();
    expect(screen.queryByText(/undefined/)).toBeNull();
  });

  it('shows the day: the strip, the totals and each class with its standing', async () => {
    renderScreen('/schedule', screens);
    expect(await screen.findByText('Morning HIIT')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Day' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: /^Thu\s*26$/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('of 20')).toBeInTheDocument();
    expect(screen.getByText('1 cancelled')).toBeInTheDocument();
    const yoga = screen.getByRole('button', { name: /Evening Yoga/ });
    expect(within(yoga).getByText('Cancelled')).toBeInTheDocument();
    expect(within(yoga).getByText('Studio floor being resurfaced')).toBeInTheDocument();
  });

  it('moves to another day', async () => {
    const user = userEvent.setup();
    renderScreen('/schedule', screens);
    await screen.findByText('Morning HIIT');
    await user.click(screen.getByRole('button', { name: /^Fri\s*27$/ }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/admin/schedule?date=2026-11-27', { branchId: 'br_kor' }));
  });

  it('opens a class in place with its roster and waitlist, and books a member', async () => {
    const user = userEvent.setup();
    routeApi({ '/admin/schedule/session/ses_1/book': () => ({ replayed: false }) });
    renderScreen('/schedule', screens);
    const hiit = await screen.findByRole('button', { name: /Morning HIIT/ });
    await user.click(hiit);
    expect(hiit).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByText('Asha Iyer')).toBeInTheDocument();
    expect(screen.getByText('SF-1001 · seat 4')).toBeInTheDocument();
    expect(screen.getByText('Ravi Shah')).toBeInTheDocument();
    expect(screen.getByText('1 booked · 1 waiting')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Book a member on'), 'mbr_9');
    await user.click(screen.getByRole('button', { name: 'Book seat' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/admin/schedule/session/ses_1/book', {
        method: 'POST',
        body: { memberId: 'mbr_9', idempotencyKey: expect.any(String), acceptDropInCharge: false },
        branchId: 'br_kor',
      }),
    );
    expect(await screen.findByText('Seat booked.')).toBeInTheDocument();
  });

  it('says the roster could not load inside the class, and retries', async () => {
    const user = userEvent.setup();
    routeApi({ '/admin/schedule/session/ses_1': () => refuse(new Error('down')) });
    renderScreen('/schedule', screens);
    await user.click(await screen.findByRole('button', { name: /Morning HIIT/ }));
    expect(await screen.findByRole('heading', { name: 'Could not load the roster' })).toBeInTheDocument();
    routeApi();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Asha Iyer')).toBeInTheDocument();
  });

  it('lets a trainer read a roster without changing the class', async () => {
    const user = userEvent.setup();
    signInAs('trainer');
    renderScreen('/schedule', screens);
    await user.click(await screen.findByRole('button', { name: /Morning HIIT/ }));
    expect(await screen.findByText('Asha Iyer')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel class' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Release' })).toBeNull();
    expect(screen.queryByLabelText('Book a member on')).toBeNull();
    expect(apiMock).not.toHaveBeenCalledWith('/admin/schedule/resources', expect.anything());
  });

  it('opens the recurring classes from the tab and keeps the tab in the URL', async () => {
    const user = userEvent.setup();
    routeApi({ '/admin/schedule/series': () => ({ series: [] }) });
    const { router } = renderScreen('/schedule', screens);
    await screen.findByText('Morning HIIT');
    await user.click(screen.getByRole('tab', { name: 'Recurring' }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ tab: 'series' }));
    expect(await screen.findByRole('heading', { name: 'No recurring classes' })).toBeInTheDocument();
  });
});
