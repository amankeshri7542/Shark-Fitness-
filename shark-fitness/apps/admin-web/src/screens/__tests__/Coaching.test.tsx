import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, api: apiMock };
});

import CoachingScreen, { type CoachDetail, type RosterItem } from '../Coaching';
import { refuse, renderScreen, setOnline, signInAs } from '../../test/harness';

const aman: RosterItem = {
  memberId: 'mbr_1',
  name: 'Aman Mehra',
  initials: 'AM',
  memberNo: 'SF-40219',
  habits: 2,
  adherence7: 64,
  lastCheckIn: { weekStart: '2026-11-23', submittedRelative: '1h', replied: false },
  awaitingReply: 1,
  flagged: true,
};

const detail: CoachDetail = {
  member: { id: 'mbr_1', name: 'Aman Mehra', memberNo: 'SF-40219' },
  habits: [
    {
      id: 'hbt_1',
      name: 'Drink water',
      target: 3,
      unit: 'litres',
      adherence7: 57,
      adherence28: 61,
      week: Array.from({ length: 7 }, (_, i) => ({ date: `2026-11-${20 + i}`, value: i % 2 ? 3 : 1, met: i % 2 === 1 })),
    },
  ],
  adherence7: 57,
  checkIns: [
    {
      id: 'wci_1',
      weekStart: '2026-11-23',
      submitted: true,
      submittedRelative: '1h',
      scores: { adherence: 2, energy: 2, hunger: 4, sleep: 2, soreness: 3, mood: 2 },
      note: 'Skipped a few meals and felt dizzy',
      coachReply: null,
      coachReplyByName: null,
      safetyEscalated: true,
      safetySignals: ['disordered_eating', 'medical'],
    },
  ],
  templates: [
    { key: 'water', name: 'Drink water', why: 'x', assigned: true },
    { key: 'sleep', name: 'Sleep 7 hours', why: 'Recovery follows sleep.', assigned: false },
  ],
};

const screens = [
  {
    path: '/coaching',
    component: CoachingScreen,
    validateSearch: (s: Record<string, unknown>) => (typeof s.member === 'string' ? { member: s.member } : {}),
  },
];

beforeEach(() => {
  apiMock.mockReset();
  setOnline(true);
  signInAs('trainer');
});
afterEach(() => setOnline(true));

describe('Coaching states', () => {
  it('shows a permission state to reception', async () => {
    signInAs('reception');
    renderScreen('/coaching', screens);
    expect(await screen.findByText('Not available to your role')).toBeInTheDocument();
  });

  it('loads, then explains an empty roster', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    apiMock.mockReturnValue(new Promise((r) => (resolve = r)));
    renderScreen('/coaching', screens);
    expect(await screen.findByLabelText('Loading members')).toBeInTheDocument();
    resolve({ items: [], counts: { flagged: 0, awaitingReply: 0 } });
    expect(await screen.findByText('No members to coach yet')).toBeInTheDocument();
  });

  it('shows an error with retry', async () => {
    apiMock.mockImplementation(() => refuse(new Error('down')));
    renderScreen('/coaching', screens);
    expect(await screen.findByText('Could not load your members')).toBeInTheDocument();
  });

  it('warns when offline', async () => {
    setOnline(false);
    apiMock.mockResolvedValue({ items: [aman], counts: { flagged: 1, awaitingReply: 1 } });
    renderScreen('/coaching', screens);
    expect(await screen.findByText(/Offline\. Replies and new habits will not save/)).toBeInTheDocument();
  });
});

describe('Coaching a member', () => {
  it('puts the flagged member first, shows the check-in in plain words and sends a reply', async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation((path: string) => {
      if (path === '/admin/coaching/members') return Promise.resolve({ items: [aman], counts: { flagged: 1, awaitingReply: 1 } });
      if (path === '/admin/coaching/members/mbr_1') return Promise.resolve(detail);
      return Promise.resolve({ ok: true });
    });
    renderScreen('/coaching', screens);
    expect(await screen.findByText('1 need a person')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Aman Mehra/ }));

    const checkIns = await screen.findByRole('region', { name: 'Weekly check-ins' });
    expect(within(checkIns).getByText('Flagged for a person')).toBeInTheDocument();
    expect(within(checkIns).getByText(/Nothing automatic answered it/)).toBeInTheDocument();
    expect(within(checkIns).getByText('Skipped a few meals and felt dizzy')).toBeInTheDocument();

    await user.type(within(checkIns).getByLabelText('Reply'), 'Let’s talk before Thursday.');
    await user.click(within(checkIns).getByRole('button', { name: 'Send reply' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/admin/coaching/check-ins/wci_1/reply', { method: 'POST', body: { reply: 'Let’s talk before Thursday.' } }),
    );

    await user.click(screen.getByRole('button', { name: '+ Sleep 7 hours' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/admin/coaching/members/mbr_1/habits', { method: 'POST', body: { templateKey: 'sleep' } }));
    expect(screen.queryByRole('button', { name: '+ Drink water' })).toBeNull();
  });
});
