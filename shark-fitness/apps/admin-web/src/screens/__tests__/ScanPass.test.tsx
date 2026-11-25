import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/api')>()), api: apiMock }));

import { ApiError } from '../../lib/api';
import { ScanPass, type ScanResult } from '../floor/ScanPass';

const CODE = `eyJ2IjoxLCJ0ZW5hbnRJZCI6InRlbl9zaGFyayJ9.${'s'.repeat(43)}`;

function result(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    granted: true,
    outcome: 'admitted',
    decision: 'granted',
    checkInId: 'chk_1',
    denialCheckInId: null,
    overridable: false,
    canOverride: false,
    memberId: 'mbr_aman',
    memberNo: 'SF-40219',
    initials: 'AM',
    memberName: 'Aman Mehta',
    branchName: 'Koramangala',
    message: null,
    visitNumber: 41,
    occupancy: { inside: 13, capacity: 120, label: 'quiet' },
    ...overrides,
  };
}

function renderScan(props: Partial<Parameters<typeof ScanPass>[0]> = {}) {
  const onDone = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
      <ScanPass
        branches={[
          { branchId: 'br_kor', branchName: 'Koramangala' },
          { branchId: 'br_ind', branchName: 'Indiranagar' },
        ]}
        defaultBranchId="br_kor"
        online
        canOverride
        onDone={onDone}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onDone };
}

const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');

beforeEach(() => {
  apiMock.mockReset();
});
afterEach(() => {
  if (originalMediaDevices) Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
  else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
});

describe('ScanPass', () => {
  it('takes a keyboard-wedge scan (code then Enter) and shows who was admitted', async () => {
    apiMock.mockResolvedValue(result());
    const { onDone } = renderScan();
    await userEvent.type(screen.getByLabelText('Pass code'), `${CODE}{Enter}`);
    expect(await screen.findByRole('heading', { name: 'Admitted' })).toBeInTheDocument();
    expect(screen.getByText('Aman Mehta')).toBeInTheDocument();
    expect(screen.getByText('AM')).toBeInTheDocument();
    expect(screen.getByText('Visit 41')).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith(
      '/admin/attendance/scan',
      expect.objectContaining({ method: 'POST', body: { token: CODE, branchId: 'br_kor' }, idempotencyKey: expect.stringMatching(/^scan:/) }),
    );
    expect(onDone).toHaveBeenCalled();
    expect(screen.getByLabelText('Pass code')).toHaveValue('');
  });

  it('submits a pasted code straight away', async () => {
    apiMock.mockResolvedValue(result({ outcome: 'already_checked_in', message: 'Already checked in.' }));
    renderScan();
    fireEvent.paste(screen.getByLabelText('Pass code'), { clipboardData: { getData: () => CODE } });
    expect(await screen.findByRole('heading', { name: 'Already checked in' })).toBeInTheDocument();
  });

  it('a refusal shows the reason, what to tell the member, and the override for a manager', async () => {
    apiMock.mockImplementation((path: string) =>
      path === '/admin/attendance/override'
        ? Promise.resolve({ member: { name: 'Aman Mehta' } })
        : Promise.resolve(
            result({
              granted: false,
              outcome: 'denied',
              decision: 'denied_branch_not_permitted',
              checkInId: null,
              denialCheckInId: 'chk_denied',
              overridable: true,
              canOverride: true,
              message: 'Your plan does not include this branch yet.',
            }),
          ),
    );
    renderScan();
    await userEvent.type(screen.getByLabelText('Pass code'), `${CODE}{Enter}`);
    expect(await screen.findByRole('heading', { name: 'Refused: Not entitled to this branch' })).toBeInTheDocument();
    expect(screen.getByText(/Your plan does not include this branch yet/)).toBeInTheDocument();
    const letIn = screen.getByRole('button', { name: 'Let them in' });
    expect(letIn).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Reason to let them in'), 'Visiting from Indiranagar');
    await userEvent.click(letIn);
    expect(await screen.findByText('Aman Mehta was let in. The reason is on the record.')).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith(
      '/admin/attendance/override',
      expect.objectContaining({ body: { checkInId: 'chk_denied', reason: 'Visiting from Indiranagar' } }),
    );
  });

  it('reception without override permission is told a manager can override', async () => {
    apiMock.mockResolvedValue(
      result({ granted: false, outcome: 'denied', decision: 'denied_capacity', overridable: true, canOverride: false, denialCheckInId: 'chk_x' }),
    );
    renderScan({ canOverride: false });
    await userEvent.type(screen.getByLabelText('Pass code'), `${CODE}{Enter}`);
    expect(await screen.findByText(/A manager can override this refusal/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Let them in' })).not.toBeInTheDocument();
  });

  it('a forged code names nobody', async () => {
    apiMock.mockResolvedValue(
      result({ granted: false, outcome: 'denied', decision: 'denied_token_invalid', memberName: null, memberNo: null, initials: null, occupancy: null }),
    );
    renderScan();
    await userEvent.type(screen.getByLabelText('Pass code'), `${CODE}{Enter}`);
    expect(await screen.findByRole('heading', { name: 'Refused: Not a valid pass' })).toBeInTheDocument();
    expect(screen.getByText('Unknown pass')).toBeInTheDocument();
  });

  it('camera blocked: says so and falls back to the code box', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'));
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    renderScan();
    await userEvent.click(screen.getByRole('button', { name: 'Scan with camera' }));
    expect(await screen.findByText(/Camera access is blocked for this console/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Pass code')).toHaveFocus());
    expect(getUserMedia).toHaveBeenCalledWith({ video: { facingMode: 'environment' }, audio: false });
  });

  it('no camera on the machine: says so and keeps the code box', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    renderScan();
    await userEvent.click(screen.getByRole('button', { name: 'Scan with camera' }));
    expect(await screen.findByText(/No camera is available on this machine/)).toBeInTheDocument();
  });

  it('a failed request says nobody was checked in', async () => {
    apiMock.mockRejectedValue(new TypeError('Failed to fetch'));
    renderScan();
    await userEvent.type(screen.getByLabelText('Pass code'), `${CODE}{Enter}`);
    expect(await screen.findByText(/Nobody was checked in/)).toBeInTheDocument();
  });

  it('a permission error from the server is shown as written', async () => {
    apiMock.mockRejectedValue(
      new ApiError(403, { error: { code: 'FORBIDDEN', message: 'You do not have permission to check members in.', requestId: 'req_1' } }),
    );
    renderScan();
    await userEvent.type(screen.getByLabelText('Pass code'), `${CODE}{Enter}`);
    expect(await screen.findByText('You do not have permission to check members in.')).toBeInTheDocument();
  });

  it('offline: nothing can be submitted', () => {
    renderScan({ online: false });
    expect(screen.getByRole('button', { name: 'Check pass' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Scan with camera' })).toBeDisabled();
  });

  it('asks which branch when the console is looking at all branches', async () => {
    apiMock.mockResolvedValue(result());
    renderScan({ defaultBranchId: null });
    await userEvent.selectOptions(screen.getByLabelText('Scanning at'), 'br_ind');
    await userEvent.type(screen.getByLabelText('Pass code'), `${CODE}{Enter}`);
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/admin/attendance/scan', expect.objectContaining({ body: { token: CODE, branchId: 'br_ind' } })),
    );
  });
});
