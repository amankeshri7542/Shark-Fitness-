import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ErrorEnvelope } from '@shark/contracts';
import { ApiError, OfflineError } from '../../lib/api';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
}));

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => {
  // Keep the real error classes — the screen branches on instanceof, so
  // substituting fakes would make the test pass for the wrong reason.
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, api: apiMock };
});

import SignInScreen from '../SignIn';

const envelope = (message: string): ErrorEnvelope => ({
  error: { code: 'UNAUTHENTICATED', message, requestId: 'req_test' },
});

describe('member sign-in', () => {
  beforeEach(() => {
    apiMock.mockReset();
    navigate.mockReset();
  });

  it('asks for a code on the identifier step', () => {
    render(<SignInScreen />);

    expect(screen.getByLabelText('Email or phone')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send my code' })).toBeEnabled();
  });

  it('explains that sign-in is the one thing needing a connection', async () => {
    const user = userEvent.setup();
    apiMock.mockRejectedValueOnce(new OfflineError());

    render(<SignInScreen />);
    await user.click(screen.getByRole('button', { name: 'Send my code' }));

    expect(
      await screen.findByText('No connection. Signing in needs one — everything else works offline.'),
    ).toBeInTheDocument();
    // A failed start must not advance to the code step.
    expect(screen.queryByLabelText('Six-digit code')).not.toBeInTheDocument();
  });

  it('shows what the server said when it refuses the sign-in', async () => {
    const user = userEvent.setup();
    apiMock.mockRejectedValueOnce(new ApiError(401, envelope('That email is not registered.')));

    render(<SignInScreen />);
    await user.click(screen.getByRole('button', { name: 'Send my code' }));

    expect(await screen.findByText('That email is not registered.')).toBeInTheDocument();
  });

  it('does not leak an unexpected failure as a blank screen', async () => {
    const user = userEvent.setup();
    apiMock.mockRejectedValueOnce(new Error('boom'));

    render(<SignInScreen />);
    await user.click(screen.getByRole('button', { name: 'Send my code' }));

    expect(await screen.findByText('That did not work. Try again.')).toBeInTheDocument();
  });

  it('advances to the code step once a challenge is issued', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValueOnce({
      challengeId: 'chg_1',
      sentTo: 'a***@sharkfitness.in',
      expiresInSec: 300,
    });

    render(<SignInScreen />);
    await user.click(screen.getByRole('button', { name: 'Send my code' }));

    expect(apiMock).toHaveBeenCalledWith('/auth/otp/start', {
      method: 'POST',
      body: { identifier: 'aman@sharkfitness.in', tenantSlug: 'shark' },
    });
    expect(await screen.findByLabelText('Six-digit code')).toBeInTheDocument();
  });

  it('switches to password sign-in and clears the previous error', async () => {
    const user = userEvent.setup();
    apiMock.mockRejectedValueOnce(new ApiError(401, envelope('That email is not registered.')));

    render(<SignInScreen />);
    await user.click(screen.getByRole('button', { name: 'Send my code' }));
    expect(await screen.findByText('That email is not registered.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Use a password instead' }));

    expect(screen.queryByText('That email is not registered.')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });
});
