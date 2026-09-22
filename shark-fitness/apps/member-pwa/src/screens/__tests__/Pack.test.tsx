import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  api: apiMock,
}));

import PackScreen from '../Pack';

const challenge = (id: string, name: string) => ({
  id,
  name,
  description: `${name} description`,
  metricLabel: 'sessions',
  fairnessNote: 'Scores are checked fairly.',
  daysLeft: 7,
  teamMode: false,
  teamName: null,
  teamTarget: null,
  teamProgress: null,
  teamShort: null,
  teamProgressPct: null,
  participantCount: 2,
  joined: true,
  anonymous: false,
  myScore: 3,
  myRank: 1,
  rewardLabel: null,
  lateJoinNote: null,
  board: [],
});

function renderPack() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><PackScreen /></QueryClientProvider>);
}

describe('Pack challenges', () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockImplementation((path: string) => {
      if (path === '/member/engagement') {
        return Promise.resolve({
          level: { level: 1, name: 'Mako', progressPct: 0, xpIntoLevel: 0, xpForNextLevel: 100, nextName: 'Tiger' },
          streak: { current: 0, longest: 0, thisWeek: 0, weeklyTarget: 4, week: [], restNote: '' },
          achievements: [], achievementsEarned: 0, achievementsTotal: 0,
          challenges: [challenge('chl_one', 'First challenge'), challenge('chl_two', 'Second challenge')],
          referral: { code: 'PACK-1', target: 3, invited: 0, joined: 0, pendingRewardMinor: 0, earnedRewardMinor: 0, shareMessage: '', rewardNote: '', invitees: [] },
        });
      }
      if (path === '/member/engagement/invitations') return Promise.resolve({ invitations: [] });
      if (path === '/member/engagement/feed') return Promise.resolve({ items: [] });
      return Promise.resolve({});
    });
  });

  it('renders every visible active challenge rather than only the first response item', async () => {
    renderPack();
    expect(await screen.findByText('First challenge')).toBeInTheDocument();
    expect(screen.getByText('Second challenge')).toBeInTheDocument();
    expect(screen.getByText('2 active')).toBeInTheDocument();
  });
});
