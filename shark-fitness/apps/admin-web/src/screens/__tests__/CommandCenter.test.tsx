import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, api: apiMock };
});

import CommandCenterScreen from '../CommandCenter';
import { refuse, renderScreen, signInAs } from '../../test/harness';

/* The Command screen (PF-DASH). Fixture follows the `/admin/dashboard`
   handler in apps/api/src/routes/admin/dashboard.ts. Every console role holds
   `dashboard.view`, so the screen has no permission state of its own; what a
   role may not see arrives as a KPI's `unavailableReason`. */

const asOf = '2026-11-26T04:30:00.000Z';

function dashboard(overrides: Record<string, unknown> = {}) {
  return {
    scope: { branchIds: ['br_kor'], branchNames: ['Koramangala'], allBranches: false },
    asOf,
    alerts: [
      {
        id: 'failed_payments',
        severity: 'critical',
        kind: 'failed_payment',
        title: '2 payments failed',
        detail: 'Members in grace lose access when it runs out.',
        count: 2,
        actionLabel: 'Open billing',
        actionTo: '/billing',
      },
    ],
    kpis: [
      {
        key: 'active_members',
        label: 'Active members',
        display: '412',
        changePct: null,
        direction: 'flat',
        goodDirection: 'up',
        freshness: 'near_realtime',
        asOf,
        drillTo: '/members?lifecycle=engaged',
        unavailableReason: null,
        definition: 'Members whose lifecycle is active, trial or corporate, at the branches in scope.',
      },
      {
        key: 'revenue_month',
        label: 'Collected this month',
        display: '—',
        changePct: null,
        direction: 'up',
        goodDirection: 'up',
        freshness: 'near_realtime',
        asOf,
        drillTo: '/billing?state=paid',
        unavailableReason: 'Revenue totals are limited to owners, regional managers and accounts.',
        definition: 'Succeeded payments recorded in the current calendar month, at the branches in scope.',
      },
    ],
    occupancy: {
      inside: 23,
      capacity: 120,
      label: 'Quiet',
      hourly: Array.from({ length: 24 }, (_, h) => (h === 7 ? 30 : 0)),
      currentHour: 10,
      byBranch: [{ id: 'br_kor', name: 'Koramangala', inside: 23, capacity: 120 }],
      opensHour: 5,
      closesHour: 23,
    },
    activity: [
      { id: 'chk_1', relativeTime: '2m', granted: true, decision: 'granted', memberName: 'Asha Iyer', memberNo: 'SF-1001', branchName: 'Koramangala' },
      { id: 'chk_2', relativeTime: '5m', granted: false, decision: 'denied_expired', memberName: 'Ravi Shah', memberNo: 'SF-1002', branchName: 'Koramangala' },
    ],
    classes: [
      { id: 'ses_1', name: 'Morning HIIT', localTime: '18:00', roomName: 'Studio A', trainerName: 'Rehan Ahmed', booked: 20, capacity: 20, fillPct: 100, cancelled: false, branchName: 'Koramangala' },
    ],
    ...overrides,
  };
}

const screens = [
  { path: '/', component: CommandCenterScreen },
  { path: '/billing', component: () => <p>Billing page</p> },
];

beforeEach(() => {
  apiMock.mockReset();
  signInAs('reception');
});

describe('CommandCenter', () => {
  it('shows a loading page, then the dashboard', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    apiMock.mockReturnValue(new Promise((r) => (resolve = r)));
    renderScreen('/', screens);
    expect(await screen.findByRole('heading', { name: 'Command' })).toBeInTheDocument();
    expect(screen.getByText('Loading')).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith('/admin/dashboard', { branchId: 'br_kor' });
    resolve(dashboard());
    expect(await screen.findByText('2 payments failed')).toBeInTheDocument();
    expect(screen.queryByText('Loading')).toBeNull();
  });

  it('says the console could not load, and retries', async () => {
    const user = userEvent.setup();
    apiMock.mockImplementationOnce(() => refuse(new Error('down')));
    renderScreen('/', screens);
    expect(await screen.findByRole('heading', { name: 'Could not load the console' })).toBeInTheDocument();
    apiMock.mockResolvedValue(dashboard());
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('2 payments failed')).toBeInTheDocument();
  });

  it('says nothing needs attention, and that the day is empty, rather than leaving blanks', async () => {
    apiMock.mockResolvedValue(dashboard({ alerts: [], activity: [], classes: [] }));
    renderScreen('/', screens);
    expect(await screen.findByText('Nothing needs you')).toBeInTheDocument();
    expect(screen.getByText('Nothing else scheduled today.')).toBeInTheDocument();
    expect(screen.getByText('No entries yet today.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create task' })).toBeNull();
  });

  it('leads with exceptions, then the building, the numbers and the day', async () => {
    apiMock.mockResolvedValue(dashboard());
    renderScreen('/', screens);
    expect(await screen.findByText('2 payments failed')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open billing' })).toHaveAttribute('href', '/billing');
    expect(screen.getByRole('img', { name: /23 of 120 inside now, Quiet/ })).toBeInTheDocument();

    // A KPI drills into the list behind it; a restricted one says why instead of showing a zero.
    expect(screen.getByRole('link', { name: /Active members/ })).toHaveAttribute('href', '/members?lifecycle=engaged');
    expect(screen.getByText('412')).toBeInTheDocument();
    expect(screen.getByText('Revenue totals are limited to owners, regional managers and accounts.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Collected this month/ })).toBeNull();

    const classes = screen.getByRole('region', { name: "Today's classes" });
    expect(within(classes).getByText('Morning HIIT')).toBeInTheDocument();
    expect(within(classes).getByText('20/20')).toBeInTheDocument();
    expect(within(classes).getByText('Full')).toBeInTheDocument();

    const door = screen.getByRole('region', { name: 'Live door' });
    expect(within(door).getByText('Asha Iyer')).toBeInTheDocument();
    expect(within(door).getAllByText('Denied')).toHaveLength(1);
  });

  it('turns an alert into a prefilled task for a role with tasks', async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation((path: string) =>
      path === '/admin/dashboard' ? Promise.resolve(dashboard()) : Promise.resolve({ items: [] }),
    );
    renderScreen('/', screens);
    await user.click(await screen.findByRole('button', { name: 'Create task' }));
    const dialog = await screen.findByRole('dialog', { name: 'New task' });
    expect(within(dialog).getByLabelText('What needs doing')).toHaveValue('2 payments failed');
  });

  it('offers no task button to a role without tasks', async () => {
    signInAs('platform_support');
    apiMock.mockResolvedValue(dashboard());
    renderScreen('/', screens);
    expect(await screen.findByText('2 payments failed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create task' })).toBeNull();
  });
});
