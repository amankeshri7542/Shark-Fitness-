import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Viewer } from '@shark/contracts';

const api = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/api')>()), api }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  Link: ({ to, params, children, className, ...rest }: { to: string; params?: Record<string, string>; children: React.ReactNode; className?: string }) => (
    <a href={Object.entries(params ?? {}).reduce((href, [key, value]) => href.replace(`$${key}`, value), to)} className={className} {...rest}>
      {children}
    </a>
  ),
}));

import { ApiError, OfflineError } from '../../lib/api';
import HomeScreen from '../Home';
import { useSession } from '../../lib/store';

const viewer: Viewer = {
  userId: 'usr_aman',
  tenantId: 'ten_shark',
  memberId: 'mbr_aman',
  staffId: null,
  name: 'Aman Mehta',
  initials: 'AM',
  email: 'aman@sharkfitness.in',
  role: 'member',
  accountState: 'active',
  homeBranchId: 'br_kor',
  permittedBranchIds: ['br_kor'],
  permissions: [],
  preferences: { register: 'plain', unitSystem: 'metric', theme: 'dark', haptics: true, reducedMotion: false },
};

const training = (overrides: Record<string, unknown> = {}) => ({
  state: 'ready',
  programDayId: 'pd_mon',
  assignmentId: 'asg_1',
  title: 'Lower A',
  blockLabel: 'Week 3 · Strength',
  exerciseCount: 5,
  setCount: 18,
  estimatedMin: 55,
  coachName: 'Rehan Khan',
  completedSets: 0,
  ...overrides,
});

/** GET /member/home as routes/member/home.ts sends it. */
function payload(overrides: Record<string, unknown> = {}) {
  return {
    member: { firstName: 'Aman', initials: 'AM', memberNo: 'SF-40219' },
    branch: { id: 'br_kor', name: 'Koramangala Depot', timezone: 'Asia/Kolkata' },
    today: { date: '2026-11-26', label: 'Thursday 26 Nov' },
    order: ['membership_issue', 'next_booking', 'training', 'stats', 'coach', 'occupancy', 'challenge'],
    membership: { id: 'msh_1', productName: 'Depot Monthly', state: 'grace', endsOn: '2026-11-30', autoRenew: false, allBranches: false, entitled: true },
    membershipIssue: {
      severity: 'warning',
      title: 'Payment overdue',
      body: 'You can still check in until 2 Dec. Pay to keep your access.',
      action: { label: 'Pay now', to: '/billing' },
    },
    outstanding: { totalMinor: 295000, invoiceCount: 1 },
    training: training(),
    nextBooking: {
      bookingId: 'bkg_1', sessionId: 'ses_1', name: 'Engine Room', roomName: 'Floor', trainerName: 'Rehan', localTime: '18:00',
      startsAt: '2026-11-26T12:30:00Z', isToday: true, seatNo: 4, capacity: 12, cancelled: false, cancelledReason: null, startsInMin: 90,
    },
    occupancy: { inside: 34, capacity: 120, label: 'quiet', pct: 28 },
    streak: { current: 6, longest: 14, thisWeek: 3, weeklyTarget: 4, week: [true, true, false, true, false, false, false], atRisk: false },
    level: { level: 4, name: 'Reef', xp: 2400, progressPct: 40, xpIntoLevel: 400, xpForNextLevel: 1000, nextName: 'Shelf' },
    monthVolumeKg: 18250,
    coachMessage: { body: 'Great squats yesterday. Add 2.5 kg on Monday.', senderName: 'Rehan Khan', relativeTime: '3h', conversationId: 'cnv_1', unread: true },
    adaptive: null,
    challenge: { id: 'chl_1', name: 'November attendance', daysLeft: 4, rank: 2, score: 9, metricLabel: 'sessions' },
    unreadNotifications: 1,
    ...overrides,
  };
}

function renderHome(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(
    <QueryClientProvider client={client}>
      <HomeScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  useSession.setState({ viewer, status: 'signed-in' } as never);
});
afterEach(() => {
  api.mockReset();
  navigate.mockReset();
});

describe('Home', () => {
  it('shows a loading skeleton first', () => {
    api.mockReturnValue(new Promise(() => undefined));
    const { container } = renderHome();
    expect(container.querySelector('.sf-skeleton')).not.toBeNull();
  });

  it('renders the day in the server’s card order, money in plain words', async () => {
    api.mockResolvedValue(payload());
    renderHome();
    expect(await screen.findByRole('heading', { level: 2, name: 'Lower A' })).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith('/member/home');
    expect(screen.getByText('Your day')).toBeInTheDocument();
    // Membership issue first, with the amount and the way to pay.
    expect(screen.getByText('Payment overdue')).toBeInTheDocument();
    expect(screen.getByText('₹2,950')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pay now' }).closest('a')).toHaveAttribute('href', '/billing');
    // Next class, today's session, stats, the coach's note and the challenge.
    expect(screen.getByText('Engine Room')).toBeInTheDocument();
    expect(screen.getByText('Rehan · Floor · seat 4 of 12')).toBeInTheDocument();
    expect(screen.getByText('5 exercises')).toBeInTheDocument();
    expect(screen.getByText('3 of 4 this week')).toBeInTheDocument();
    expect(screen.getByText('400 / 1,000 to Shelf')).toBeInTheDocument();
    expect(screen.getByText('18.3')).toBeInTheDocument();
    expect(screen.getByText('Great squats yesterday. Add 2.5 kg on Monday.').closest('a')).toHaveAttribute('href', '/messages/cnv_1');
    expect(screen.getByText('#2').closest('a')).toHaveAttribute('href', '/pack/challenge/chl_1');
    const cards = ['Payment overdue', 'Engine Room', 'Lower A', 'Great squats yesterday. Add 2.5 kg on Monday.', 'Floor occupancy', 'November attendance'].map((text) => screen.getByText(text));
    for (let i = 1; i < cards.length; i += 1) {
      expect(cards[i - 1]!.compareDocumentPosition(cards[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('starts today’s session and opens the plan', async () => {
    api.mockResolvedValue(payload());
    renderHome();
    fireEvent.click(await screen.findByRole('button', { name: 'Start session' }));
    expect(navigate).toHaveBeenCalledWith({ to: '/workout' });
    fireEvent.click(screen.getByRole('button', { name: 'Plan' }));
    expect(navigate).toHaveBeenCalledWith({ to: '/train' });
  });

  it('a session under way offers to resume; a finished one cannot be started again', async () => {
    api.mockResolvedValueOnce(payload({ training: training({ state: 'in_progress', completedSets: 6 }) }));
    const first = renderHome();
    expect(await screen.findByRole('button', { name: 'Resume session' })).toBeEnabled();
    first.unmount();

    api.mockResolvedValueOnce(payload({ training: training({ state: 'done' }) }));
    renderHome();
    expect(await screen.findByRole('button', { name: 'Logged today' })).toBeDisabled();
  });

  it('rest day and no plan: says so and still gives a way to train', async () => {
    api.mockResolvedValueOnce(payload({ training: training({ state: 'rest', title: 'Rest' }) }));
    const first = renderHome();
    expect(await screen.findByText('Rest day')).toBeInTheDocument();
    expect(screen.getByText(/Rest is part of the plan/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start session' })).not.toBeInTheDocument();
    first.unmount();

    api.mockResolvedValueOnce(payload({ training: training({ state: 'no_program', title: 'No plan yet' }) }));
    renderHome();
    fireEvent.click(await screen.findByRole('button', { name: 'Browse exercises' }));
    expect(navigate).toHaveBeenCalledWith({ to: '/train' });
  });

  it('a cancelled class says why', async () => {
    api.mockResolvedValue(
      payload({ nextBooking: { ...payload().nextBooking, cancelled: true, cancelledReason: 'Rehan is unwell. Your credit is back.' } }),
    );
    renderHome();
    expect(await screen.findByText('Rehan is unwell. Your credit is back.')).toBeInTheDocument();
  });

  it('a member with nothing booked and no issues sees only what applies', async () => {
    api.mockResolvedValue(
      payload({ order: ['training', 'stats', 'occupancy'], membershipIssue: null, outstanding: { totalMinor: 0, invoiceCount: 0 }, nextBooking: null, coachMessage: null, challenge: null }),
    );
    renderHome();
    expect(await screen.findByRole('heading', { level: 2, name: 'Lower A' })).toBeInTheDocument();
    expect(screen.queryByText('Payment overdue')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open your bookings' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Book a class' })).toBeInTheDocument();
  });

  it('error with nothing saved: says the workout data is safe, and retries', async () => {
    api.mockRejectedValueOnce(new ApiError(500, { error: { code: 'INTERNAL', message: 'x', requestId: 'req_home' } }));
    renderHome();
    expect(await screen.findByRole('heading', { name: 'Could not load your day' })).toBeInTheDocument();
    api.mockResolvedValue(payload());
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Lower A' })).toBeInTheDocument();
  });

  it('offline with a saved day: keeps showing it when the refresh fails', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // What the persisted snapshot restores on an offline start.
    client.setQueryData(['home'], payload(), { updatedAt: Date.now() - 60 * 60 * 1000 });
    api.mockRejectedValue(new OfflineError());
    renderHome(client);
    expect(screen.getByRole('heading', { level: 2, name: 'Lower A' })).toBeInTheDocument();
    await waitFor(() => expect(api).toHaveBeenCalledWith('/member/home'));
    await waitFor(() => expect(client.getQueryState(['home'])?.status).toBe('error'));
    expect(screen.getByRole('heading', { level: 2, name: 'Lower A' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Could not load your day' })).not.toBeInTheDocument();
  });
});
