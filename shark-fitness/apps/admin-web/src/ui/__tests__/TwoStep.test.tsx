import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/api')>()), api }));
vi.mock('../../lib/store', () => ({ useAdmin: (select: (state: Record<string, unknown>) => unknown) => select({ signOut: vi.fn() }) }));

import { ApiError } from '../../lib/api';
import { MfaChallengeForm, MfaEnrolmentFlow, QrCode, TwoStepGate, groupKey } from '../TwoStep';

function renderWithQuery(element: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

const enrolment = { secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', uri: 'otpauth://totp/Shark%20Fitness:owner%40gym.test?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Shark%20Fitness', issuer: 'Shark Fitness', account: 'owner@gym.test' };
const codes = Array.from({ length: 10 }, (_, index) => `ABCD${index}-EFGH${index}`);
const error = (status: number, message: string) => new ApiError(status, { error: { code: 'VALIDATION_FAILED', message, requestId: 'r' } });

beforeEach(() => {
  api.mockReset();
});

it('draws the QR code as an accessible image', () => {
  render(<QrCode value={enrolment.uri} label="QR code to add owner@gym.test" />);
  const image = screen.getByRole('img', { name: 'QR code to add owner@gym.test' });
  expect(image.querySelectorAll('rect').length).toBeGreaterThan(100);
  expect(groupKey('ABCDEFGHIJ')).toBe('ABCD EFGH IJ');
});

it('enrols: shows a loading state, the setup key, then recovery codes that must be acknowledged', async () => {
  let resolveStart: (value: unknown) => void = () => undefined;
  api.mockImplementation((path: string) => {
    if (path === '/auth/mfa/enrol/start') return new Promise((resolve) => (resolveStart = resolve));
    if (path === '/auth/mfa/enrol/confirm') return Promise.resolve({ viewer: { role: 'owner' }, recoveryCodes: codes });
    throw new Error(path);
  });
  const onEnrolled = vi.fn();
  renderWithQuery(<MfaEnrolmentFlow onEnrolled={onEnrolled} doneLabel="Continue to the console" />);
  expect(screen.getByLabelText('6-digit code')).toBeDisabled();
  resolveStart(enrolment);
  expect(await screen.findByTestId('mfa-setup-key')).toHaveTextContent('JBSW Y3DP EHPK 3PXP');
  expect(screen.getByRole('img', { name: /QR code to add owner@gym.test/ })).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '12 34 56' } });
  fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('/auth/mfa/enrol/confirm', { method: 'POST', body: { code: '123456' } }));

  expect(await screen.findByRole('list', { name: 'Recovery codes' })).toHaveTextContent('ABCD0-EFGH0');
  const done = screen.getByRole('button', { name: 'Continue to the console' });
  expect(done).toBeDisabled();
  fireEvent.click(screen.getByLabelText('I have stored these codes somewhere safe'));
  fireEvent.click(done);
  expect(onEnrolled).toHaveBeenCalled();
});

it('shows a failed setup and a wrong first code', async () => {
  api.mockRejectedValueOnce(error(409, 'Two-step sign-in is already set up on this account.'));
  renderWithQuery(<MfaEnrolmentFlow onEnrolled={vi.fn()} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('already set up');

  api.mockReset();
  api.mockImplementation((path: string) =>
    path === '/auth/mfa/enrol/start' ? Promise.resolve(enrolment) : Promise.reject(error(422, 'That code is not right. Check your authenticator app and try again.')),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await screen.findByTestId('mfa-setup-key');
  fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '000000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
  expect(await screen.findByText(/That code is not right/)).toBeInTheDocument();
});

it('verifies a code, or a recovery code instead', async () => {
  api.mockRejectedValueOnce(error(422, 'That code is not right. Check your authenticator app and try again.')).mockResolvedValueOnce({ viewer: {}, recoveryCodesRemaining: 9 });
  const onVerified = vi.fn();
  renderWithQuery(<MfaChallengeForm onVerified={onVerified} />);
  fireEvent.change(screen.getByLabelText('Authenticator code'), { target: { value: '111111' } });
  fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
  expect(await screen.findByText(/That code is not right/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Use a recovery code' }));
  fireEvent.change(screen.getByLabelText('Recovery code'), { target: { value: 'abcde-fghij' } });
  fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
  await waitFor(() => expect(onVerified).toHaveBeenCalledWith({ viewer: {}, recoveryCodesRemaining: 9 }));
  expect(api).toHaveBeenLastCalledWith('/auth/mfa/verify', { method: 'POST', body: { recoveryCode: 'ABCDE-FGHIJ' } });
});

it('explains why the gate cannot be skipped when the gym requires it', async () => {
  api.mockImplementation((path: string) =>
    path === '/auth/mfa' ? Promise.resolve({ enrolled: false, required: true, requiredBy: 'gym', enrolledAt: null, recoveryCodesRemaining: 0, sessionState: 'enrol' }) : Promise.resolve(enrolment),
  );
  renderWithQuery(<TwoStepGate state="enrol" onComplete={vi.fn()} />);
  expect(screen.getByRole('heading', { level: 1, name: 'Set up two-step sign-in' })).toBeInTheDocument();
  expect(await screen.findByText(/Your gym requires two-step sign-in for all staff/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
});
