import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
const mocks = vi.hoisted(() => ({ api: vi.fn(), navigate: vi.fn(), search: {} as { redirect?: string }, bootstrap: vi.fn(), setMfaPending: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate, useSearch: () => mocks.search }));
vi.mock('../../lib/api', async (original) => ({ ...await original<typeof import('../../lib/api')>(), api: mocks.api }));
vi.mock('../../lib/store', () => ({
  useAdmin: (select: (state: Record<string, unknown>) => unknown) => select({ bootstrap: mocks.bootstrap, setMfaPending: mocks.setMfaPending }),
}));
import SignIn from '../SignIn';
beforeEach(() => {
  window.history.replaceState(null, '', '/sign-in');
  mocks.api.mockReset().mockRejectedValue(new Error('offline'));
  mocks.navigate.mockReset();
  mocks.bootstrap.mockReset().mockResolvedValue(undefined);
  mocks.setMfaPending.mockReset();
  mocks.search = {};
});
it('signs in to the selected gym', async () => {
  render(<SignIn />);
  fireEvent.change(screen.getByLabelText('Gym code'), { target: { value: 'fresh-gym' } });
  fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'owner@fresh.test' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'fresh-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('/auth/password', { method: 'POST', body: { tenantSlug: 'fresh-gym', email: 'owner@fresh.test', password: 'fresh-password' } }));
});
it('uses a private fragment link to activate a staff account', async () => {
  window.history.replaceState(null, '', '/sign-in#activationId=one&activationToken=secret&gym=fresh-gym');
  render(<SignIn />);
  expect(screen.queryByLabelText('Work email')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'fresh-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Activate account' }));
  await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('/auth/activation/redeem', { method: 'POST', body: { activationId: 'one', token: 'secret', password: 'fresh-password' } }));
});

it('uses distinct recovery authority and returns to sign-in after replacing the password', async () => {
  window.history.replaceState(null, '', '/sign-in#recoveryId=one&recoveryToken=private-token&gym=fresh-gym');
  mocks.api.mockResolvedValue({ recovered: true });
  render(<SignIn />);
  expect(screen.queryByRole('button', { name: 'Activate account' })).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Work email')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'replacement-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Set new password' }));
  await screen.findByRole('status');
  expect(mocks.api).toHaveBeenCalledWith('/auth/recovery/redeem', { method: 'POST', body: { recoveryId: 'one', token: 'private-token', password: 'replacement-password' } });
  expect(screen.getByLabelText('Password')).toHaveValue('');
  expect(screen.getByLabelText('Work email')).toHaveValue('');
  expect(window.location.hash).toBe('');
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
});

it('updates activation credentials when a link changes the mounted page fragment', async () => {
  window.history.replaceState(null, '', '/sign-in');
  mocks.api.mockReset().mockRejectedValue(new Error('offline'));
  render(<SignIn />);
  window.history.replaceState(null, '', '/sign-in#activationId=next&activationToken=secret&gym=other-gym');
  fireEvent(window, new HashChangeEvent('hashchange'));
  fireEvent.change(await screen.findByLabelText('Password'), { target: { value: 'fresh-password-123' } });
  fireEvent.click(screen.getByRole('button', { name: 'Activate account' }));
  await screen.findByText('That did not work. Try again.');
  expect(mocks.api).toHaveBeenCalledWith('/auth/activation/redeem', { method: 'POST', body: { activationId: 'next', token: 'secret', password: 'fresh-password-123' } });
  window.history.replaceState(null, '', '/sign-in');
  fireEvent(window, new HashChangeEvent('hashchange'));
  expect(screen.getByLabelText('Work email')).toBeInTheDocument();
  expect(screen.getByLabelText('Gym code')).toHaveValue('other-gym');
  expect(screen.queryByRole('button', { name: 'Activate account' })).not.toBeInTheDocument();
});

async function submitPassword() {
  fireEvent.change(screen.getByLabelText('Gym code'), { target: { value: 'shark' } });
  fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'owner@sharkfitness.in' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'shark1234' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

it.each(['challenge', 'enrol'] as const)('hands a password sign-in that owes MFA (%s) to the two-step gate', async (state) => {
  mocks.api.mockResolvedValue({ viewer: { role: 'owner' }, csrfToken: 't', mfa: { state } });
  render(<SignIn />);
  await submitPassword();
  await waitFor(() => expect(mocks.setMfaPending).toHaveBeenCalledWith(state));
  expect(mocks.bootstrap).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();
});

it('returns to the page a session expired on, and only to a console path', async () => {
  mocks.search = { redirect: '/members?q=aman' };
  mocks.api.mockResolvedValue({ viewer: { role: 'owner' }, csrfToken: 't', mfa: { state: 'verified' } });
  render(<SignIn />);
  expect(screen.getByText('Your session ended. Sign in again to go back to where you were.')).toBeInTheDocument();
  await submitPassword();
  await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({ href: '/members?q=aman' }));

  mocks.navigate.mockReset();
  mocks.search = { redirect: '//evil.example/steal' };
  render(<SignIn />);
  fireEvent.change(screen.getAllByLabelText('Gym code')[1]!, { target: { value: 'shark' } });
  fireEvent.change(screen.getAllByLabelText('Work email')[1]!, { target: { value: 'owner@sharkfitness.in' } });
  fireEvent.change(screen.getAllByLabelText('Password')[1]!, { target: { value: 'shark1234' } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Sign in' })[1]!);
  await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({ href: '/' }));
});
