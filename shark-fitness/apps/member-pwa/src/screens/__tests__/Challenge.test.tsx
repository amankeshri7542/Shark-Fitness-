import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/api')>()), api }));
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ challengeId: 'chl_1' }),
}));

import { ApiError } from '../../lib/api';
import ChallengeScreen from '../Challenge';

const row = (overrides: Record<string, unknown> = {}) => ({
  rank: 1,
  memberId: 'mbr_neha',
  displayName: 'Neha S.',
  initials: 'NS',
  score: 12,
  rawCount: 12,
  isYou: false,
  isPrivate: false,
  isBlocked: false,
  teamId: null,
  flagged: false,
  ...overrides,
});

/** GET /member/engagement/challenge/:id as routes/member/engagement.ts sends it. */
function payload(challenge: Record<string, unknown> = {}, rest: Record<string, unknown> = {}) {
  return {
    challenge: {
      id: 'chl_1',
      name: 'November attendance',
      description: 'Show up. Every visit counts.',
      metric: 'sessions',
      metricLabel: 'sessions',
      ranked: true,
      unrankedReason: null,
      fairnessNote: 'Scores compare rate, not totals.',
      startsOn: '2026-11-01',
      endsOn: '2026-11-30',
      totalDays: 30,
      daysElapsed: 26,
      daysLeft: 4,
      branchId: null,
      visibility: 'tenant',
      teamMode: false,
      teamId: null,
      teamName: null,
      teamTarget: null,
      teamProgress: null,
      teamShort: null,
      teamProgressPct: null,
      participantCount: 3,
      joined: true,
      anonymous: false,
      myScore: 9,
      myRank: 2,
      rules: 'One visit a day counts.',
      rewardLabel: 'A free PT session for the top three.',
      ...challenge,
    },
    board: [
      row(),
      row({ rank: 2, memberId: 'mbr_aman', displayName: 'You', initials: 'YOU', score: 9, isYou: true }),
      row({ rank: 3, memberId: null, displayName: 'Shark #4471', initials: '##', score: 7, isPrivate: true, flagged: true }),
    ],
    you: null,
    teams: [],
    fairnessNote: 'Scores compare rate, not totals.',
    privacyNote: 'Private mode keeps your place on the board and replaces your name with a Shark number. Nobody, including staff, sees a different ranking.',
    ...rest,
  };
}

function renderChallenge() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <ChallengeScreen />
    </QueryClientProvider>,
  );
}

afterEach(() => api.mockReset());

describe('Challenge', () => {
  it('shows a loading skeleton first', () => {
    api.mockReturnValue(new Promise(() => undefined));
    const { container } = renderChallenge();
    expect(container.querySelector('.sf-skeleton')).not.toBeNull();
  });

  it('shows the board as sent: your rank, private entrants by number only, flagged scores marked', async () => {
    api.mockResolvedValue(payload());
    renderChallenge();
    expect(await screen.findByRole('heading', { level: 1, name: 'November attendance' })).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith('/member/engagement/challenge/chl_1');
    expect(screen.getByText('Your rank')).toBeInTheDocument();
    expect(screen.getByText('Neha S.')).toBeInTheDocument();
    expect(screen.getByText('Shark #4471')).toBeInTheDocument();
    expect(screen.getByText('Private')).toBeInTheDocument();
    expect(screen.getByText('Under review')).toBeInTheDocument();
    expect(screen.getByText('A free PT session for the top three.')).toBeInTheDocument();
    expect(screen.getByText('One visit a day counts.')).toBeInTheDocument();
    expect(screen.getByText(/replaces your name with a Shark number/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave challenge' })).toBeInTheDocument();
  });

  it('an unranked metric shows the reason, never a board', async () => {
    api.mockResolvedValue(
      payload(
        { ranked: false, unrankedReason: 'This challenge is not ranked. Volume lifted and body metrics are never put on a leaderboard.', metricLabel: 'volume lifted', myRank: null },
        { board: [] },
      ),
    );
    renderChallenge();
    expect(await screen.findByText('Not ranked')).toBeInTheDocument();
    expect(screen.getByText(/Volume lifted and body metrics are never put on a leaderboard/)).toBeInTheDocument();
    expect(screen.getByText('Your score')).toBeInTheDocument();
    expect(screen.queryByText('Neha S.')).not.toBeInTheDocument();
  });

  it('empty board: invites the first score', async () => {
    api.mockResolvedValue(payload({ joined: false, myRank: null, myScore: null, participantCount: 0 }, { board: [] }));
    renderChallenge();
    expect(await screen.findByText('Nobody has scored yet. First one on the board sets the pace.')).toBeInTheDocument();
    expect(screen.queryByText('Your rank')).not.toBeInTheDocument();
  });

  it('team mode: the squad’s progress against its target', async () => {
    api.mockResolvedValue(
      payload(
        { teamMode: true, teamId: 'team_a', teamName: 'Hammerheads', teamTarget: 100, teamProgress: 64, teamProgressPct: 64 },
        { teams: [{ teamId: 'team_a', name: 'Hammerheads', rawCount: 64, members: 4 }, { teamId: 'team_b', name: 'Makos', rawCount: 51, members: 4 }] },
      ),
    );
    renderChallenge();
    expect(await screen.findByText('64 of 100')).toBeInTheDocument();
    expect(screen.getByText('Makos')).toBeInTheDocument();
  });

  it('joins, then refreshes the challenge', async () => {
    api.mockImplementation(async (path: string) => (path.endsWith('/join') ? { ok: true } : payload({ joined: false, myRank: null })));
    renderChallenge();
    fireEvent.click(await screen.findByRole('button', { name: 'Join challenge' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/member/engagement/challenge/chl_1/join', { method: 'POST', body: {} }));
    await waitFor(() => expect(api.mock.calls.filter(([path]) => path === '/member/engagement/challenge/chl_1')).toHaveLength(2));
  });

  it('a refused join says why', async () => {
    api.mockImplementation(async (path: string) => {
      if (path.endsWith('/join')) throw new ApiError(409, { error: { code: 'CONFLICT', message: 'That challenge has already finished.', requestId: 'r' } });
      return payload({ joined: false, myRank: null });
    });
    renderChallenge();
    fireEvent.click(await screen.findByRole('button', { name: 'Join challenge' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That challenge has already finished.');
  });

  it('another branch’s challenge (permission refused): the reason, and no pointless retry', async () => {
    api.mockRejectedValue(new ApiError(403, { error: { code: 'FORBIDDEN', message: 'That challenge belongs to a branch you are not a member of.', requestId: 'req_403' } }));
    renderChallenge();
    expect(await screen.findByText('That challenge belongs to a branch you are not a member of.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('error: says the score is safe, and retries', async () => {
    api.mockRejectedValueOnce(new ApiError(500, { error: { code: 'INTERNAL', message: 'x', requestId: 'req_chl' } }));
    renderChallenge();
    expect(await screen.findByRole('heading', { name: 'Could not load this challenge' })).toBeInTheDocument();
    expect(screen.getByText('Ref req_chl')).toBeInTheDocument();
    api.mockResolvedValue(payload());
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'November attendance' })).toBeInTheDocument();
  });
});
