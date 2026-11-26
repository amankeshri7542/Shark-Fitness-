import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SetupChecklist } from '@shark/contracts';
import { refuse, renderScreen, signInAs } from '../../test/harness';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, api };
});

import SettingsScreen from '../Settings';

const TABS = ['business', 'branches', 'privacy', 'security', 'integrations', 'setup'];
const screens = [
  {
    path: '/settings',
    component: SettingsScreen,
    validateSearch: (s: Record<string, unknown>) => ({ tab: TABS.includes(s.tab as string) ? (s.tab as string) : 'business' }),
  },
];

const setup = (overrides: Partial<SetupChecklist> = {}): SetupChecklist => ({
  items: [
    { key: 'branch', label: 'Add your first location', why: 'Everything hangs off a branch.', done: true, to: '/settings?tab=branches', blocking: true },
    { key: 'hours', label: 'Set opening hours', why: 'The door refuses entry outside them.', done: false, to: '/settings?tab=branches', blocking: true },
    { key: 'tax', label: 'Record your tax details', why: 'Invoices need a registration number.', done: false, to: '/settings?tab=business', blocking: true },
    { key: 'rooms', label: 'Name your rooms and studios', why: 'Room capacity caps bookings.', done: false, to: '/settings?tab=branches', blocking: false },
  ],
  done: 1,
  total: 4,
  readyToOpen: false,
  ...overrides,
});

const business = {
  legalName: 'Shark Fitness Private Limited',
  displayName: 'Shark Fitness',
  locale: 'en-IN',
  currency: 'INR',
  timezone: 'Asia/Kolkata',
  unitSystem: 'metric',
  taxProfile: null,
  dataProcessing: null,
  slug: 'shark',
  plan: 'growth',
  status: 'active',
};

function respond(checklist: SetupChecklist | Error = setup()) {
  api.mockImplementation((path: string) => {
    if (path === '/admin/settings/setup') return checklist instanceof Error ? refuse(checklist) : Promise.resolve(checklist);
    if (path === '/admin/settings/business') return Promise.resolve(business);
    if (path === '/admin/privacy/requests') return Promise.resolve({ requests: [], deliveryNote: 'Handed over by a person.' });
    return new Promise(() => undefined);
  });
}

beforeEach(() => {
  api.mockReset();
  signInAs('owner');
});

describe('Settings', () => {
  it('refuses a role without settings.manage, and reads nothing to say so', async () => {
    signInAs('branch_manager');
    renderScreen('/settings', screens);
    expect(await screen.findByText('Not available to your role')).toBeInTheDocument();
    expect(screen.getByText(/Gym settings is restricted/)).toBeInTheDocument();
    expect(screen.queryByRole('tablist', { name: 'Settings' })).not.toBeInTheDocument();
    expect(api).not.toHaveBeenCalled();
  });

  it('puts no verdict in the header while the checklist is still loading', async () => {
    api.mockReturnValue(new Promise(() => undefined));
    renderScreen('/settings', screens);
    expect(await screen.findByRole('tablist', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.queryByText('Ready to open')).not.toBeInTheDocument();
    expect(screen.queryByText(/before members arrive/)).not.toBeInTheDocument();
  });

  it('counts what blocks opening in the header and beside the Setup tab', async () => {
    respond();
    renderScreen('/settings', screens);
    expect(await screen.findByText('2 before members arrive')).toBeInTheDocument();
    // Three outstanding in all; the hint sits beside the tab that clears them.
    expect(screen.getByRole('tab', { name: /^Setup\s*3$/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Business' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByDisplayValue('Shark Fitness Private Limited')).toBeInTheDocument();
  });

  it('says the gym is ready to open once nothing blocks it', async () => {
    respond(setup({ readyToOpen: true, done: 4, total: 4 }));
    renderScreen('/settings', screens);
    expect(await screen.findByText('Ready to open')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Setup' })).toBeInTheDocument();
  });

  it('keeps the tabs working when the checklist cannot be read, and says so on the Setup tab', async () => {
    respond(new Error('down'));
    renderScreen('/settings?tab=setup', screens);
    expect(await screen.findByText('The checklist could not be read')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    // A failed read is not "ready" and not "nothing outstanding".
    expect(screen.queryByText('Ready to open')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Business' })).toBeInTheDocument();
  });

  it('keeps the open tab in the URL so it can be sent to somebody', async () => {
    respond();
    const { router } = renderScreen('/settings', screens);
    await userEvent.click(await screen.findByRole('tab', { name: 'Privacy' }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ tab: 'privacy' }));
    expect(screen.getByRole('tab', { name: 'Privacy' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('No open requests')).toBeInTheDocument();
  });
});
