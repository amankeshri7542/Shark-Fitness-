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

import StaffDetailScreen from '../StaffDetail';

const screens = [
  { path: '/staff/$staffId', component: StaffDetailScreen },
  { path: '/members/$memberId', component: () => <p>Member page</p> },
];

const profile = (overrides: Record<string, unknown> = {}) => ({
  staff: {
    id: 'stf_rehan',
    name: 'Rehan Shaikh',
    initials: 'RS',
    email: 'rehan@sharkfitness.in',
    phone: '+91 98450 11223',
    role: 'trainer',
    accountState: 'active',
    employmentStatus: 'active',
    branchIds: ['br_kor'],
    specialties: ['Strength', 'Mobility'],
    certifications: [
      { name: 'ACE Personal Trainer', expiresOn: '2027-03-31', status: 'valid' },
      { name: 'First aid', expiresOn: '2026-12-10', status: 'expiring' },
    ],
    hourlyRateMinor: 45_000,
    commissionRules: [{ kind: 'membership_sale', ratePct: 5 }],
    joinedOn: '2024-02-12',
    ...overrides,
  },
  workload: {
    activeCount: 1,
    members: [
      { assignmentId: 'asg_1', memberId: 'mbr_aman', memberNo: 'SF-0042', name: 'Aman Mehra', programName: 'Strength Base', currentWeek: 3, weeks: 8, startsOn: '2026-11-03' },
    ],
  },
  shifts: [
    { id: 'shf_1', branchId: 'br_kor', startsAt: '2026-11-27T00:30:00.000Z', endsAt: '2026-11-27T08:30:00.000Z', role: 'floor', state: 'planned', conflict: true, coveredByStaffId: null, note: null },
  ],
});

const impact = {
  sessions: [{ sessionId: 'ses_hiit', className: 'HIIT 6am', branchId: 'br_kor', startsAt: Date.parse('2026-11-27T00:30:00Z'), localDate: '2026-11-27', booked: 14, capacity: 20 }],
  appointments: [{ appointmentId: 'apt_1', memberId: 'mbr_aman', memberName: 'Aman Mehra', startsAt: Date.parse('2026-11-27T05:00:00Z'), kind: 'pt_session' }],
  shifts: [],
};

type Handler = (path: string, options?: { method?: string; body?: unknown }) => Promise<unknown> | undefined;
function respond(extra?: Handler, detail = profile()) {
  api.mockImplementation((path: string, options?: { method?: string; body?: unknown }) => {
    const handled = extra?.(path, options);
    if (handled) return handled;
    if (path === '/admin/staff/stf_rehan' && !options?.method) return Promise.resolve(detail);
    if (path === '/admin/staff/stf_rehan/unavailability' && !options?.method) {
      return Promise.resolve({ unavailability: [{ id: 'una_1', startsAt: Date.parse('2026-11-27T00:00:00Z'), endsAt: Date.parse('2026-11-28T00:00:00Z'), reason: 'sick', note: 'Fever', state: 'active' }] });
    }
    if (path === '/admin/staff/stf_rehan/coverage') return Promise.resolve(impact);
    if (path === '/admin/staff/stf_rehan' && options?.method === 'PATCH') return Promise.resolve({ ok: true });
    return Promise.reject(new Error(`unexpected ${path}`));
  });
}

beforeEach(() => {
  api.mockReset();
  setOnline(true);
  signInAs('regional_manager');
});
afterEach(() => setOnline(true));

describe('StaffDetail', () => {
  it('refuses a role without staff.view, and reads nothing', async () => {
    signInAs('reception');
    renderScreen('/staff/stf_rehan', screens);
    expect(await screen.findByText('Not available to your role')).toBeInTheDocument();
    expect(screen.getByText(/This staff profile is restricted/)).toBeInTheDocument();
    expect(api).not.toHaveBeenCalled();
  });

  it('says it is loading rather than showing an empty profile', async () => {
    api.mockReturnValue(new Promise(() => undefined));
    renderScreen('/staff/stf_rehan', screens);
    expect(await screen.findByText('Loading')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Profile' })).not.toBeInTheDocument();
  });

  it('says the profile could not be read, and recovers on retry', async () => {
    respond((path) =>
      path === '/admin/staff/stf_rehan'
        ? refuse(new ApiError(404, { error: { code: 'NOT_FOUND', message: 'No such staff member in this gym.', requestId: 'r' } }))
        : undefined,
    );
    renderScreen('/staff/stf_rehan', screens);
    expect(await screen.findByText('Could not load this profile')).toBeInTheDocument();
    expect(screen.getByText('No such staff member in this gym.')).toBeInTheDocument();

    respond();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Rehan Shaikh', level: 1 })).toBeInTheDocument();
  });

  it('shows the profile, credentials, shifts, workload and pay rules', async () => {
    respond();
    renderScreen('/staff/stf_rehan', screens);
    expect(await screen.findByRole('heading', { name: 'Rehan Shaikh', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('Trainer · Koramangala')).toBeInTheDocument();

    const certs = screen.getByRole('region', { name: 'Certifications' });
    expect(within(certs).getByText('2 recorded')).toBeInTheDocument();
    expect(within(certs).getByText('Expires 2026-12-10')).toBeInTheDocument();

    const shifts = screen.getByRole('region', { name: 'Shifts and availability' });
    expect(within(shifts).getByText('overlap')).toBeInTheDocument();
    expect(within(shifts).getByText('Koramangala · floor')).toBeInTheDocument();

    const workload = screen.getByRole('region', { name: 'Trainer workload' });
    expect(within(workload).getByRole('link', { name: /Aman Mehra/ })).toHaveAttribute('href', '/members/mbr_aman');
    expect(within(workload).getByText('Week 3/8')).toBeInTheDocument();

    expect(within(screen.getByRole('region', { name: 'Compensation rules' })).getByText('5%')).toBeInTheDocument();
  });

  it('lists the recorded absence and what it puts at risk, without moving anything', async () => {
    respond();
    renderScreen('/staff/stf_rehan', screens);
    const cover = await screen.findByRole('region', { name: 'Availability and cover' });
    expect(await within(cover).findByText('Off sick')).toBeInTheDocument();
    expect(within(cover).getByText(/Fever/)).toBeInTheDocument();
    expect(await within(cover).findByText('HIIT 6am')).toBeInTheDocument();
    expect(within(cover).getByText('2026-11-27 · 14/20 booked')).toBeInTheDocument();
    expect(within(cover).getByText('Needs a conversation')).toBeInTheDocument();
  });

  it('does not call someone available when their absences could not be read', async () => {
    respond((path) =>
      path.endsWith('/unavailability') || path.endsWith('/coverage')
        ? refuse(new ApiError(503, { error: { code: 'INTERNAL', message: 'Rota service unavailable.', requestId: 'r' } }))
        : undefined,
    );
    renderScreen('/staff/stf_rehan', screens);
    const cover = await screen.findByRole('region', { name: 'Availability and cover' });
    // Regression: a failed read rendered "Available — no absence is recorded".
    expect(await within(cover).findByText('Absences could not be read')).toBeInTheDocument();
    expect(within(cover).queryByText('Available')).not.toBeInTheDocument();
    expect(await within(cover).findByText('What this affects could not be read')).toBeInTheDocument();
    expect(within(cover).getAllByRole('button', { name: 'Try again' })).toHaveLength(2);
  });

  it('says cover could not be looked up, rather than showing nothing', async () => {
    respond((path) =>
      path === '/admin/schedule/session/ses_hiit/substitutes' ? refuse(new Error('down')) : undefined,
    );
    renderScreen('/staff/stf_rehan', screens);
    await userEvent.click(await screen.findByRole('button', { name: 'Find cover' }));
    expect(await screen.findByText('Cover could not be looked up')).toBeInTheDocument();
  });

  it('assigns cover from the eligible coaches and says who is covering', async () => {
    respond((path, options) => {
      if (path === '/admin/schedule/session/ses_hiit/substitutes') {
        return Promise.resolve({
          candidates: [
            { staffId: 'stf_priya', name: 'Priya Rao', eligible: true, blockedReason: null, matchingSpecialties: ['HIIT'], expiredCertifications: [], sessionsThatDay: 1 },
            { staffId: 'stf_omar', name: 'Omar Khan', eligible: false, blockedReason: 'Already teaching at 06:30', matchingSpecialties: [], expiredCertifications: ['First aid'], sessionsThatDay: 3 },
          ],
        });
      }
      if (path === '/admin/schedule/session/ses_hiit/substitute' && options?.method === 'POST') return Promise.resolve({ ok: true });
      return undefined;
    });
    renderScreen('/staff/stf_rehan', screens);
    await userEvent.click(await screen.findByRole('button', { name: 'Find cover' }));
    expect(await screen.findByText('Already teaching at 06:30')).toBeInTheDocument();
    expect(screen.getByText('Lapsed: First aid')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unavailable' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Assign cover' }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/admin/schedule/session/ses_hiit/substitute', { method: 'POST', body: { trainerId: 'stf_priya' }, branchId: 'br_kor' }),
    );
    expect(await screen.findByText("Priya Rao is covering. Everyone booked in has been told, and nobody's seat moved.")).toBeInTheDocument();
  });

  it('withholds pay rules and edits from a branch manager', async () => {
    signInAs('branch_manager');
    respond();
    renderScreen('/staff/stf_rehan', screens);
    await screen.findByRole('heading', { name: 'Rehan Shaikh', level: 1 });
    const pay = screen.getByRole('region', { name: 'Compensation rules' });
    expect(within(pay).getByText('Not available to your role')).toBeInTheDocument();
    expect(within(pay).queryByText('5%')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit profile' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deactivate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark unavailable' })).not.toBeInTheDocument();
  });

  it('deactivates an account only after confirming what it does', async () => {
    respond();
    renderScreen('/staff/stf_rehan', screens);
    await userEvent.click(await screen.findByRole('button', { name: 'Deactivate' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Deactivate staff account?' });
    expect(within(dialog).getByText(/Rehan Shaikh will no longer be able to sign in/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/admin/staff/stf_rehan', { method: 'PATCH', body: { accountState: 'disabled', employmentStatus: 'former' } }),
    );
    expect(await screen.findByText('Staff profile saved.')).toBeInTheDocument();
  });

  it('says why a profile edit was refused', async () => {
    respond((path, options) =>
      options?.method === 'PATCH'
        ? refuse(new ApiError(422, { error: { code: 'VALIDATION_FAILED', message: 'That email is already in use.', requestId: 'r' } }))
        : undefined,
    );
    renderScreen('/staff/stf_rehan', screens);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit profile' }));
    const panel = screen.getByRole('region', { name: 'Profile' });
    await userEvent.clear(within(panel).getByLabelText('Email'));
    await userEvent.type(within(panel).getByLabelText('Email'), 'priya@sharkfitness.in');
    await userEvent.click(within(panel).getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByText('That email is already in use.')).toBeInTheDocument();
  });

  it('offers the owner account activation, and keeps edits off while offline', async () => {
    signInAs('owner');
    setOnline(false);
    respond();
    renderScreen('/staff/stf_rehan', screens);
    expect(await screen.findByText('You are offline. The profile is read-only until the connection returns.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Account activation' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit profile' })).not.toBeInTheDocument();
  });
});
