import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  api: apiMock,
}));

import { ApiError, OfflineError } from '../../lib/api';
import { WeeklyCheckIn, type CheckInPayload } from '../habits/WeeklyCheckIn';

const KEYS = ['adherence', 'energy', 'hunger', 'sleep', 'soreness', 'mood'] as const;
const payload = (over: Partial<CheckInPayload> = {}): CheckInPayload => ({
  optedOut: false,
  weekStart: '2026-11-23',
  weekLabel: '23 Nov – 29 Nov',
  scales: KEYS.map((key) => ({ key, label: key[0]!.toUpperCase() + key.slice(1), low: 'Low', high: 'High' })),
  checkIn: null,
  coach: { name: 'Rehan Khan' },
  privacyNote: 'Your coach (Rehan Khan) reads this. It is not posted anywhere and it is not scored.',
  ...over,
});

function renderIt() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WeeklyCheckIn />
    </QueryClientProvider>,
  );
}

async function fillScales(user: ReturnType<typeof userEvent.setup>) {
  for (const key of KEYS) {
    await user.click(screen.getByRole('radio', { name: new RegExp(`^${key}: 3 of 5`, 'i') }));
  }
}

beforeEach(() => apiMock.mockReset());

describe('WeeklyCheckIn', () => {
  it('shows a loading state, then the form with who reads it', async () => {
    apiMock.mockResolvedValueOnce(payload());
    const { container } = renderIt();
    expect(container.querySelector('.sf-skeleton')).not.toBeNull();
    expect(await screen.findByText(/Your coach \(Rehan Khan\) reads this/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to Rehan Khan' })).toBeDisabled();
  });

  it('sends all six scales and the note, then says who will reply', async () => {
    apiMock.mockResolvedValueOnce(payload());
    apiMock.mockResolvedValueOnce({ checkIn: null, safety: null, acknowledgement: 'Sent. Rehan Khan reads these and will reply here.' });
    apiMock.mockResolvedValueOnce(
      payload({ checkIn: { id: 'wci_1', weekStart: '2026-11-23', adherence: 3, energy: 3, hunger: 3, sleep: 3, soreness: 3, mood: 3, note: 'Good week', submitted: true, submittedRelative: 'just now', coachReply: null, safetyEscalated: false } }),
    );
    const user = userEvent.setup();
    renderIt();
    await screen.findByText(/reads this/);
    await fillScales(user);
    await user.type(screen.getByRole('textbox', { name: /Anything else/ }), 'Good week');
    await user.click(screen.getByRole('button', { name: 'Send to Rehan Khan' }));
    expect(apiMock).toHaveBeenCalledWith('/member/habits/check-in', {
      method: 'POST',
      body: { weekStart: '2026-11-23', adherence: 3, energy: 3, hunger: 3, sleep: 3, soreness: 3, mood: 3, note: 'Good week' },
    });
    expect(await screen.findByText('Sent. Rehan Khan reads these and will reply here.')).toBeInTheDocument();
    expect(screen.getByText('Waiting for Rehan Khan to reply.')).toBeInTheDocument();
  });

  it('shows the safety response exactly as the server sends it', async () => {
    apiMock.mockResolvedValueOnce(payload());
    apiMock.mockResolvedValueOnce({
      checkIn: null,
      acknowledgement: null,
      safety: {
        headline: 'A person will read this',
        body: 'Thanks for writing that down.',
        whatHappensNext: ['Rehan Khan sees this check-in flagged for a human to read.'],
        resources: [{ title: 'Talk to the desk', detail: 'Koramangala front desk', contact: '+91 80 0000 0000' }],
        reference: 'SAF-123',
      },
    });
    apiMock.mockResolvedValue(payload());
    const user = userEvent.setup();
    renderIt();
    await screen.findByText(/reads this/);
    await fillScales(user);
    await user.click(screen.getByRole('button', { name: 'Send to Rehan Khan' }));
    expect(await screen.findByText('A person will read this')).toBeInTheDocument();
    expect(screen.getByText('Talk to the desk')).toBeInTheDocument();
    expect(screen.getByText('Reference SAF-123')).toBeInTheDocument();
  });

  it('shows the coach’s reply to this week', async () => {
    apiMock.mockResolvedValueOnce(
      payload({ checkIn: { id: 'wci_1', weekStart: '2026-11-23', adherence: 3, energy: 3, hunger: 3, sleep: 3, soreness: 3, mood: 3, note: '', submitted: true, submittedRelative: '2 days ago', coachReply: 'Nice work on sleep.', safetyEscalated: false } }),
    );
    renderIt();
    expect(await screen.findByText('Nice work on sleep.')).toBeInTheDocument();
    expect(screen.getByText('Rehan Khan replied')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Send to/ })).toBeNull();
  });

  it('says why a send failed, offline or refused', async () => {
    apiMock.mockResolvedValueOnce(payload());
    apiMock.mockRejectedValueOnce(new OfflineError());
    const user = userEvent.setup();
    renderIt();
    await screen.findByText(/reads this/);
    await fillScales(user);
    await user.click(screen.getByRole('button', { name: 'Send to Rehan Khan' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You are offline. Nothing was sent.');
  });

  it('shows an error with retry when it cannot load, and nothing when the member opted out', async () => {
    apiMock.mockRejectedValueOnce(new ApiError(500, { error: { code: 'INTERNAL', message: 'Boom', requestId: 'req_1' } } as never));
    apiMock.mockResolvedValueOnce(payload({ optedOut: true }));
    const user = userEvent.setup();
    const { container } = renderIt();
    expect(await screen.findByText('Could not load this week’s check-in')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
