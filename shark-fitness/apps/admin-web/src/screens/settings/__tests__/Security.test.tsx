import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { StaffMfaRow } from '@shark/contracts';
import { renderPanel } from './harness';

const mocks = vi.hoisted(() => ({ api: vi.fn(), role: 'owner', canManageStaff: true }));
vi.mock('../../../lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../lib/api')>()), api: mocks.api }));
vi.mock('../../../lib/store', () => ({
  useAdmin: (select: (state: unknown) => unknown) => select({ viewer: { role: mocks.role, userId: 'usr_owner' } }),
  usePermission: () => mocks.canManageStaff,
}));

import Security from '../Security';

const row = (overrides: Partial<StaffMfaRow>): StaffMfaRow => ({
  staffId: 'stf_1', userId: 'usr_1', name: 'Rehan Shaikh', role: 'trainer', enrolled: false, required: false, enrolledAt: null, lockedUntil: null, ...overrides,
});

function respond(staff: StaffMfaRow[] = []) {
  mocks.api.mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
    if (path === '/admin/security/settings' && !options?.method) return { requireMfaForStaff: false, staffIdleTimeoutMinutes: 30, mandatoryRoles: ['owner'] };
    if (path === '/admin/security/settings') return { requireMfaForStaff: true, staffIdleTimeoutMinutes: 60, mandatoryRoles: ['owner'] };
    if (path === '/admin/security/staff-mfa') return { items: staff };
    if (path.endsWith('/mfa/reset')) return { ok: true };
    throw new Error(path);
  });
}

beforeEach(() => {
  mocks.api.mockReset();
  mocks.role = 'owner';
  mocks.canManageStaff = true;
});

it('is closed to roles without settings access', () => {
  renderPanel(<Security canManage={false} />);
  expect(screen.getByText('Not available to your role')).toBeInTheDocument();
  expect(mocks.api).not.toHaveBeenCalled();
});

it('saves the staff MFA rule and idle timeout', async () => {
  respond();
  renderPanel(<Security canManage />);
  const box = await screen.findByLabelText(/Require two-step sign-in for all staff/);
  const save = screen.getByRole('button', { name: 'Save rules' });
  expect(save).toBeDisabled();
  fireEvent.click(box);
  fireEvent.change(screen.getByLabelText('Sign staff out after this long without activity'), { target: { value: '60' } });
  fireEvent.click(save);
  await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('/admin/security/settings', { method: 'PATCH', body: { requireMfaForStaff: true, staffIdleTimeoutMinutes: 60 } }));
  expect(await screen.findByText('Saved.')).toBeInTheDocument();
  expect(screen.getByText('No staff yet')).toBeInTheDocument();
});

it('lists staff status and lets the owner reset a colleague with a reason', async () => {
  respond([
    row({ staffId: 'stf_mgr', userId: 'usr_mgr', name: 'Asha Rao', role: 'regional_manager', enrolled: true, required: true }),
    row({ staffId: 'stf_own', userId: 'usr_owner', name: 'Vikas Menon', role: 'owner', enrolled: true, required: true }),
    row({ staffId: 'stf_desk', name: 'Desk', role: 'reception', required: true }),
    row({ staffId: 'stf_lock', name: 'Locked One', enrolled: true, lockedUntil: '2026-11-25T10:00:00.000Z' }),
  ]);
  renderPanel(<Security canManage />);
  const table = await screen.findByRole('table', { name: 'Staff two-step sign-in status' });
  expect(within(table).getByText('Required, not set up')).toBeInTheDocument();
  expect(within(table).getByText('Locked after wrong codes')).toBeInTheDocument();
  expect(screen.getByText('1 still to set up')).toBeInTheDocument();
  // Never their own.
  expect(screen.queryByRole('button', { name: 'Reset two-step sign-in for Vikas Menon' })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Reset two-step sign-in for Asha Rao' }));
  const dialog = screen.getByRole('alertdialog');
  fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Checked her ID at the desk' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Reset' }));
  await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('/admin/security/staff/stf_mgr/mfa/reset', { method: 'POST', body: { reason: 'Checked her ID at the desk' } }));
});

it('does not offer resets to anyone but the owner', async () => {
  mocks.role = 'regional_manager';
  respond([row({ staffId: 'stf_x', name: 'Someone', enrolled: true })]);
  renderPanel(<Security canManage />);
  await screen.findByRole('table');
  expect(screen.queryByRole('button', { name: /Reset two-step/ })).not.toBeInTheDocument();
  expect(screen.getByText('Only the gym owner can reset someone’s two-step sign-in.')).toBeInTheDocument();
});

it('shows a load failure', async () => {
  mocks.api.mockRejectedValue(new Error('down'));
  renderPanel(<Security canManage />);
  expect(await screen.findByText('Could not load security settings')).toBeInTheDocument();
  expect(await screen.findByText('Could not load staff')).toBeInTheDocument();
});
