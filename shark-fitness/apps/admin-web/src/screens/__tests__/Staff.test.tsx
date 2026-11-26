import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../../lib/api';
import { refuse, renderScreen, setOnline, signInAs } from '../../test/harness';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, api };
});

import StaffScreen from '../Staff';

const screens = [
  {
    path: '/staff',
    component: StaffScreen,
    validateSearch: (s: Record<string, unknown>) => ({ tab: s.tab === 'commission' ? 'commission' : 'directory' }),
  },
  { path: '/staff/$staffId', component: () => <p>Staff profile</p> },
];

const person = (overrides: Record<string, unknown> = {}) => ({
  id: 'stf_rehan',
  name: 'Rehan Shaikh',
  initials: 'RS',
  email: 'rehan@sharkfitness.in',
  role: 'trainer',
  employmentStatus: 'active',
  branchIds: ['br_kor'],
  specialties: ['Strength', 'Mobility'],
  assignedMemberCount: 14,
  utilisationPct: 82,
  ...overrides,
});

const directory = (items = [person(), person({ id: 'stf_priya', name: 'Priya Rao', initials: 'PR', role: 'reception', employmentStatus: 'on_leave', specialties: [] })], overrides: Record<string, unknown> = {}) => ({
  total: items.length,
  page: 1,
  pageSize: 25,
  totalPages: 1,
  hasMore: false,
  totals: { active: 1, trainers: 1, onLeave: 1, certificationsNeedingAttention: 2 },
  items,
  ...overrides,
});

beforeEach(() => {
  api.mockReset();
  setOnline(true);
  signInAs('owner');
});
afterEach(() => setOnline(true));

describe('Staff', () => {
  it('refuses a role without staff.view, and reads nothing', async () => {
    signInAs('reception');
    renderScreen('/staff', screens);
    expect(await screen.findByText('Not available to your role')).toBeInTheDocument();
    expect(screen.getByText(/The staff directory is restricted/)).toBeInTheDocument();
    expect(api).not.toHaveBeenCalled();
  });

  it('says it is loading rather than showing an empty directory', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    api.mockReturnValue(new Promise((r) => (resolve = r)));
    renderScreen('/staff', screens);
    expect(await screen.findByText('Loading')).toBeInTheDocument();
    expect(screen.queryByText('No staff match this view')).not.toBeInTheDocument();
    resolve(directory());
    expect(await screen.findByText('Rehan Shaikh')).toBeInTheDocument();
  });

  it('says the directory could not be read, and recovers on retry', async () => {
    api.mockImplementationOnce(() =>
      refuse(new ApiError(500, { error: { code: 'INTERNAL', message: 'Directory unavailable.', requestId: 'r' } })),
    );
    renderScreen('/staff', screens);
    expect(await screen.findByText('Could not load the directory')).toBeInTheDocument();
    expect(screen.getByText('Directory unavailable.')).toBeInTheDocument();

    api.mockResolvedValue(directory());
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Rehan Shaikh')).toBeInTheDocument();
  });

  it('invites the first staff member into an empty directory', async () => {
    api.mockResolvedValue(directory([], { totals: { active: 0, trainers: 0, onLeave: 0, certificationsNeedingAttention: 0 } }));
    renderScreen('/staff', screens);
    expect(await screen.findByText('No staff match this view')).toBeInTheDocument();
    expect(screen.getByText('Add your first staff member to get started.')).toBeInTheDocument();
  });

  it('lists the team in scope with role, status, branch and workload', async () => {
    api.mockResolvedValue(directory());
    renderScreen('/staff', screens);
    const rehan = await screen.findByRole('link', { name: /Rehan Shaikh/ });
    expect(rehan).toHaveAttribute('href', '/staff/stf_rehan');
    expect(within(rehan).getByText('Trainer')).toBeInTheDocument();
    expect(within(rehan).getByText('Koramangala')).toBeInTheDocument();
    expect(within(rehan).getByText('14 assigned · 82% utilised')).toBeInTheDocument();
    const priya = screen.getByRole('link', { name: /Priya Rao/ });
    expect(within(priya).getByText('on leave')).toBeInTheDocument();
    expect(screen.getByText('2 in scope')).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith('/admin/staff?page=1&pageSize=25', { branchId: 'br_kor' });
  });

  it('filters by role and says when nothing matches the filters', async () => {
    api.mockResolvedValue(directory());
    renderScreen('/staff', screens);
    await screen.findByText('Rehan Shaikh');
    api.mockResolvedValue(directory([]));
    await userEvent.selectOptions(screen.getByLabelText('Role'), 'accountant');
    expect(await screen.findByText('Nothing matches those filters.')).toBeInTheDocument();
    expect(api).toHaveBeenLastCalledWith('/admin/staff?page=1&pageSize=25&role=accountant', { branchId: 'br_kor' });
  });

  it('gives commission its own tab to a role that holds it, and none to one that does not', async () => {
    api.mockImplementation((path: string) =>
      path === '/admin/staff/commission/rules'
        ? Promise.resolve({ kinds: [], tenantRates: [], unsourcedKinds: [], canApprove: true })
        : path.startsWith('/admin/staff/commission?')
          ? Promise.resolve({ periodStart: '2026-11-01', periodEnd: '2026-11-26', currency: 'INR', staff: [], totals: { pendingMinor: 0, approvedMinor: 0, paidMinor: 0, totalMinor: 0 }, settlementNote: 'No money moves here.' })
          : Promise.resolve(directory()),
    );
    const { router } = renderScreen('/staff', screens);
    await userEvent.click(await screen.findByRole('tab', { name: 'Commission' }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ tab: 'commission' }));
    expect(await screen.findByText('Nothing accrued in this period')).toBeInTheDocument();
  });

  it('hides the commission tab from a branch manager', async () => {
    signInAs('branch_manager');
    api.mockResolvedValue(directory());
    renderScreen('/staff?tab=commission', screens);
    expect(await screen.findByText('Rehan Shaikh')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Commission' })).not.toBeInTheDocument();
    // No invite either: staff.manage is not theirs.
    expect(screen.queryByRole('button', { name: 'Add staff' })).not.toBeInTheDocument();
  });

  it('invites staff, and asks for a name first', async () => {
    api.mockImplementation((path: string, options?: { method?: string }) =>
      options?.method === 'POST' ? Promise.resolve({ staff: { id: 'stf_new' } }) : Promise.resolve(directory()),
    );
    renderScreen('/staff', screens);
    await userEvent.click(await screen.findByRole('button', { name: 'Add staff' }));
    const dialog = screen.getByRole('dialog', { name: 'Invite staff' });

    await userEvent.click(within(dialog).getByRole('button', { name: 'Invite staff' }));
    expect(within(dialog).getByText('Name is required.')).toBeInTheDocument();

    await userEvent.type(within(dialog).getByLabelText('Name'), 'Kavya Iyer');
    await userEvent.type(within(dialog).getByLabelText('Email'), 'kavya@sharkfitness.in');
    await userEvent.type(within(dialog).getByLabelText('Specialties'), 'Yoga, Mobility');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Invite staff' }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        '/admin/staff',
        expect.objectContaining({
          method: 'POST',
          body: { name: 'Kavya Iyer', email: 'kavya@sharkfitness.in', phone: null, role: 'trainer', branchIds: ['br_kor'], specialties: ['Yoga', 'Mobility'] },
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Invite staff' })).not.toBeInTheDocument());
  });

  it('keeps the directory readable offline and stops invitations', async () => {
    setOnline(false);
    api.mockResolvedValue(directory());
    renderScreen('/staff', screens);
    expect(await screen.findByText('You are offline. The directory is read-only until the connection returns.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add staff' })).toBeDisabled();
  });
});
