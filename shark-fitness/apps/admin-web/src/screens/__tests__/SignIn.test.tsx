import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
const mocks = vi.hoisted(() => ({ api: vi.fn(), navigate: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('../../lib/api', async (original) => ({ ...await original<typeof import('../../lib/api')>(), api: mocks.api }));
vi.mock('../../lib/store', () => ({ useAdmin: () => vi.fn() }));
import SignIn from '../SignIn';
beforeEach(() => { window.history.replaceState(null, '', '/sign-in'); mocks.api.mockReset().mockRejectedValue(new Error('offline')); });
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
