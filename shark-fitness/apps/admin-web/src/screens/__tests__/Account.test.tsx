import type { ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { DeviceSession, MfaStatus } from '@shark/contracts';
import { renderPanel } from '../settings/__tests__/harness';

const mocks = vi.hoisted(() => ({ api: vi.fn(), state: { impersonation: null as unknown, setMfaPending: vi.fn() } }));
vi.mock('../../lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/api')>()), api: mocks.api }));
vi.mock('../../lib/store', () => {
  const useAdmin = (select: (state: unknown) => unknown) => select(mocks.state);
  useAdmin.getState = () => mocks.state;
  return { useAdmin, useBranchTimeZone: () => 'Asia/Kolkata' };
});
vi.mock('../../ui/shell', () => ({ Page: ({ children }: { children: ReactNode }) => <main>{children}</main> }));

import { ApiError } from '../../lib/api';
import Account from '../Account';

const status = (overrides: Partial<MfaStatus> = {}): MfaStatus => ({
  enrolled: true, required: true, requiredBy: 'role', enrolledAt: '2026-11-01T00:00:00.000Z', recoveryCodesRemaining: 8, sessionState: 'verified', ...overrides,
});
const device = (overrides: Partial<DeviceSession>): DeviceSession => ({
  id: 'ses_1', createdAt: '2026-11-25T03:00:00.000Z', lastSeenAt: '2026-11-25T04:00:00.000Z', lastActiveAt: '2026-11-25T04:00:00.000Z',
  expiresAt: '2026-11-25T15:00:00.000Z', userAgent: 'x', device: 'Chrome on Windows', ip: '203.0.113.9', current: true, ...overrides,
});

function route(responses: Record<string, unknown>) {
  mocks.api.mockImplementation(async (path: string, options?: { method?: string }) => {
    const key = `${options?.method ?? 'GET'} ${path}`;
    if (!(key in responses)) throw new Error(`unexpected ${key}`);
    const value = responses[key];
    if (value instanceof Error) throw value;
    return value;
  });
}

beforeEach(() => {
  mocks.api.mockReset();
  mocks.state.impersonation = null;
  mocks.state.setMfaPending.mockReset();
});

it('shows loading, then the two-step status and every device, and signs another device out', async () => {
  route({
    'GET /auth/mfa': status(),
    'GET /me/sessions': { items: [device({}), device({ id: 'ses_2', device: 'Safari on iOS', current: false, ip: '198.51.100.4' })] },
    'DELETE /me/sessions/ses_2': { ok: true },
  });
  renderPanel(<Account />);
  expect(document.querySelectorAll('.sf-skeleton').length).toBeGreaterThan(0);
  expect(await screen.findByText('Required for your role')).toBeInTheDocument();
  expect(screen.getByText(/8 of 10 recovery codes left/)).toBeInTheDocument();
  const table = await screen.findByRole('table', { name: 'Devices signed in as you' });
  expect(within(table).getByText('This device')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /Sign out Safari on iOS/ }));
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Sign out' }));
  await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('/me/sessions/ses_2', { method: 'DELETE' }));
  expect(screen.getByRole('button', { name: 'Sign out everywhere else' })).toBeInTheDocument();
});

it('says when this is the only device, and offers set-up when two-step is off', async () => {
  route({ 'GET /auth/mfa': status({ enrolled: false, required: false, requiredBy: 'none', recoveryCodesRemaining: 0 }), 'GET /me/sessions': { items: [device({})] } });
  renderPanel(<Account />);
  expect(await screen.findByText('Only this device')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Sign out everywhere else' })).not.toBeInTheDocument();
  expect(await screen.findByRole('button', { name: 'Set up' })).toBeInTheDocument();
});

it('shows errors with a retry', async () => {
  route({
    'GET /auth/mfa': new ApiError(500, { error: { code: 'INTERNAL', message: 'Something went wrong on our side.', requestId: 'r' } }),
    'GET /me/sessions': new ApiError(500, { error: { code: 'INTERNAL', message: 'Something went wrong on our side.', requestId: 'r' } }),
  });
  renderPanel(<Account />);
  expect(await screen.findByText('Could not load your devices')).toBeInTheDocument();
  expect(screen.getByText('Could not load')).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: 'Try again' })).toHaveLength(2);
});

it('moves a required factor to a new phone by sending the session back to enrolment', async () => {
  route({ 'GET /auth/mfa': status(), 'GET /me/sessions': { items: [device({})] }, 'DELETE /auth/mfa': { sessionState: 'enrol' } });
  renderPanel(<Account />);
  fireEvent.click(await screen.findByRole('button', { name: 'Move to a new phone' }));
  expect(screen.getByRole('alertdialog')).toHaveTextContent('set it up again straight away');
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(mocks.state.setMfaPending).toHaveBeenCalledWith('enrol'));
});

it('does not let a support session change the account holder’s sign-in', async () => {
  mocks.state.impersonation = { actor: 'Noel' };
  route({ 'GET /me/sessions': { items: [device({}), device({ id: 'ses_2', current: false })] } });
  renderPanel(<Account />);
  expect(screen.getByText(/This is a support session/)).toBeInTheDocument();
  await screen.findByRole('table');
  expect(screen.queryByRole('button', { name: /Sign out/ })).not.toBeInTheDocument();
  expect(mocks.api).not.toHaveBeenCalledWith('/auth/mfa');
});
