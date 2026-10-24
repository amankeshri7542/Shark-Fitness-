import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AccountRecovery } from '../AccountRecovery';

const apiMock = vi.hoisted(() => vi.fn());
const actor = vi.hoisted(() => ({ owner: true }));
vi.mock('../../lib/api', async (original) => ({ ...await original<typeof import('../../lib/api')>(), api: apiMock }));
vi.mock('../../lib/store', () => ({ useAdmin: () => actor.owner }));
beforeEach(() => { apiMock.mockReset(); actor.owner = true; });

it('does not offer recovery authorization to reception or another non-owner', () => {
  actor.owner = false;
  render(<AccountRecovery memberId="member" />);
  expect(screen.queryByRole('button', { name: 'Create recovery link' })).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Your current owner password')).not.toBeInTheDocument();
});

it('requires explicit identity verification, reason and owner password, then clears the password and allows hiding the private handoff', async () => {
  apiMock.mockResolvedValue({ recoveryId: 'synthetic', token: 'synthetic-private-token', expiresAt: '2026-09-30T12:15:00Z', tenantSlug: 'gym', email: 'member@test.invalid' });
  render(<AccountRecovery memberId="member" />);
  const issue = screen.getByRole('button', { name: 'Create recovery link' });
  expect(issue).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Recovery reason'), { target: { value: 'Verified against gym records.' } });
  fireEvent.change(screen.getByLabelText('Your current owner password'), { target: { value: 'synthetic-owner-password' } });
  expect(issue).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(issue);
  const link = await screen.findByLabelText('Private recovery link');
  expect(apiMock).toHaveBeenCalledWith('/auth/recovery/issue', { method: 'POST', body: { memberId: 'member', staffId: undefined, currentPassword: 'synthetic-owner-password', identityVerified: true, reason: 'Verified against gym records.' } });
  expect((link as HTMLInputElement).value).toContain('/sign-in#recoveryId=synthetic&recoveryToken=synthetic-private-token&gym=gym');
  expect(screen.getByLabelText('Your current owner password')).toHaveValue('');
  expect(screen.getByRole('checkbox')).not.toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Hide recovery link' }));
  expect(screen.queryByLabelText('Private recovery link')).not.toBeInTheDocument();
});

it('shows a retryable initiation failure without retaining the owner password', async () => {
  apiMock.mockRejectedValue(new Error('offline'));
  render(<AccountRecovery staffId="staff" />);
  fireEvent.change(screen.getByLabelText('Recovery reason'), { target: { value: 'Verified against gym records.' } });
  fireEvent.change(screen.getByLabelText('Your current owner password'), { target: { value: 'synthetic-owner-password' } });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Create recovery link' }));
  await screen.findByRole('alert');
  await waitFor(() => expect(screen.getByLabelText('Your current owner password')).toHaveValue(''));
  expect(screen.queryByLabelText('Private recovery link')).not.toBeInTheDocument();
});
