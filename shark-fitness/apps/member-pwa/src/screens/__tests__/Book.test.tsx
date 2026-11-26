import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, api };
});

import Book from '../Book';

const day = (date: string, weekday: string, dayNo: number, sessionCount: number) => ({
  date, weekday, dayNo, monthLabel: 'Oct', isToday: date === '2026-10-24', sessionCount,
});

const schedule = {
  branch: { id: 'br_kor', name: 'Koramangala Depot' },
  date: '2026-10-24',
  dateLabel: 'Saturday 24 October',
  days: [day('2026-10-24', 'Sat', 24, 8), day('2026-10-25', 'Sun', 25, 1), day('2026-10-26', 'Mon', 26, 0)],
  category: 'all',
  categories: [{ value: 'all', label: 'All', count: 8 }],
  membership: { entitled: true, reason: null, productName: 'Depot Monthly' },
  credits: { class: 4 },
  waitlist: { available: true, offerWindowMin: 30, message: '' },
  items: [],
};

it('names each day in the strip for a screen reader, count included', async () => {
  api.mockResolvedValue(schedule);
  render(<QueryClientProvider client={new QueryClient()}><Book /></QueryClientProvider>);

  // Without a label the stacked spans read as "Sat 24 8".
  const saturday = await screen.findByRole('button', { name: 'Sat 24, 8 classes' });
  expect(saturday).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Sun 25, 1 class' })).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByRole('button', { name: 'Mon 26, 0 classes' })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Sun 25, 1 class' }));
  await waitFor(() => expect(api).toHaveBeenLastCalledWith('/member/schedule?date=2026-10-25'));
});

it('confirms a drop-in fee, with its amount and terms, before booking', async () => {
  const dropIn = {
    id: 'ses_1', name: 'Engine Room', category: 'conditioning', intensity: 'high', description: '', trainerName: 'Rehan', roomName: 'Floor',
    branchName: 'Koramangala Depot', localTime: '07:00', localEndTime: '07:45', durationMin: 45, capacity: 12, booked: 4, seatsLeft: 8,
    waitlistCount: 0, state: 'scheduled', cancelledReason: null, substituteFor: null, myBooking: null, myWaitlist: null,
    eligibility: { canBook: true, action: 'pay', reason: 'Needs 1 class credit · you have 0.', creditsRequired: 1, creditsHeld: 0, dropInPriceMinor: 50000, cancelDeadlineAt: null },
  };
  api.mockImplementation(async (path: string) => (path.startsWith('/member/schedule/book') ? { ok: true } : { ...schedule, items: [dropIn] }));
  render(<QueryClientProvider client={new QueryClient()}><Book /></QueryClientProvider>);

  fireEvent.click(await screen.findByRole('button', { name: '₹500' }));
  const dialog = await screen.findByRole('dialog', { name: 'Book with a drop-in fee' });
  expect(dialog).toHaveTextContent('Needs 1 class credit · you have 0.');
  expect(dialog).toHaveTextContent('Pay it at reception when you arrive; it is not charged online.');
  // Nothing is booked or charged until the member says yes.
  expect(api.mock.calls.some(([path]) => path === '/member/schedule/book')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(api.mock.calls.some(([path]) => path === '/member/schedule/book')).toBe(false);

  fireEvent.click(screen.getByRole('button', { name: '₹500' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Book · ₹500' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('/member/schedule/book', expect.objectContaining({
    method: 'POST', body: expect.objectContaining({ sessionId: 'ses_1', acceptDropInCharge: true }),
  })));
});

/* ——— Waitlist offers (P05, decision 12) ——————————————————————— */

const baseSession = {
  id: 'ses_full', name: 'Engine Room', category: 'conditioning', intensity: 'high', description: '', trainerName: 'Rehan', roomName: 'Floor',
  branchName: 'Koramangala Depot', localTime: '18:00', localEndTime: '18:45', durationMin: 45, capacity: 12, booked: 12, seatsLeft: 0,
  waitlistCount: 3, state: 'scheduled', cancelledReason: null, substituteFor: null, myBooking: null, myWaitlist: null,
  eligibility: { canBook: true, action: 'waitlist', reason: 'Class is full. Join the waitlist.', creditsRequired: 1, creditsHeld: 2, dropInPriceMinor: null, cancelDeadlineAt: null },
};

function offerAt(secondsLeft: number) {
  const serverNow = Date.now();
  return {
    serverNow: new Date(serverNow).toISOString(),
    offer: {
      waitlistId: 'wtl_1', sessionId: 'ses_full', name: 'Engine Room', trainerName: 'Rehan', localDate: '2026-10-24',
      dateLabel: 'Saturday 24 October', localTime: '18:00', offerExpiresAt: new Date(serverNow + secondsLeft * 1000).toISOString(),
      creditsRequired: 1, dropInPriceMinor: null,
    },
  };
}

function renderBook() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Book /></QueryClientProvider>);
}

it('shows what a full class costs before joining the line: "Uses 1 credit"', async () => {
  api.mockResolvedValue({ ...schedule, items: [baseSession] });
  renderBook();
  expect(await screen.findByText('Uses 1 class credit · you have 2')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Waitlist' }));
  const dialog = await screen.findByRole('dialog', { name: 'Join the waitlist' });
  expect(dialog).toHaveTextContent('You would be number 4 in line.');
  // Escape closes it; nothing was joined.
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(api.mock.calls.some(([path]) => path === '/member/schedule/waitlist')).toBe(false);
});

it('a held seat shows its countdown; the dialog takes the seat through the accept endpoint', async () => {
  const { serverNow, offer } = offerAt(14 * 60 + 5);
  const offered = { ...baseSession, myWaitlist: { id: 'wtl_1', position: 1, state: 'offered', offerExpiresAt: offer.offerExpiresAt } };
  api.mockImplementation(async (path: string) =>
    path.endsWith('/accept') ? { message: 'Seat taken. 1 class credit was used.' } : { ...schedule, serverNow, offers: [offer], items: [offered] },
  );
  renderBook();

  expect(await screen.findByText('A seat is held for you')).toBeInTheDocument();
  expect(screen.getByText(/^14:0[45]$/)).toBeInTheDocument();
  expect(screen.getByText('Uses 1 class credit')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
  const dialog = await screen.findByRole('dialog', { name: 'A seat is held for you' });
  expect(dialog).toHaveTextContent('Engine Room with Rehan · Saturday 24 October at 18:00.');
  // Focus starts inside the dialog.
  expect(dialog).toContainElement(document.activeElement as HTMLElement);

  fireEvent.click(screen.getByRole('button', { name: 'Take the seat' }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      '/member/schedule/waitlist/wtl_1/accept',
      expect.objectContaining({ method: 'POST', body: expect.objectContaining({ acceptDropInCharge: false }) }),
    ),
  );
  expect(await screen.findByText('Seat taken. 1 class credit was used.')).toBeInTheDocument();
});

it('letting a held seat go declines it; Escape only closes the dialog and keeps the offer', async () => {
  const { serverNow, offer } = offerAt(600);
  api.mockImplementation(async (path: string, init?: { method?: string }) =>
    init?.method === 'DELETE' ? { message: 'Seat declined. It has gone to the next person. Nothing was charged.' } : { ...schedule, serverNow, offers: [offer], items: [] },
  );
  renderBook();
  fireEvent.click(await screen.findByRole('button', { name: 'Answer' }));
  await screen.findByRole('dialog', { name: 'A seat is held for you' });
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(api.mock.calls.some(([, init]) => (init as { method?: string } | undefined)?.method === 'DELETE')).toBe(false);

  fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Let it go' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('/member/schedule/waitlist/wtl_1', { method: 'DELETE' }));
  expect(await screen.findByText(/It has gone to the next person/)).toBeInTheDocument();
});

it('an offer that has run out cannot be taken', async () => {
  const { serverNow, offer } = offerAt(0);
  api.mockResolvedValue({ ...schedule, serverNow, offers: [offer], items: [] });
  renderBook();
  expect(await screen.findByText('This offer has run out.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Answer' })).toBeDisabled();
});

it('a refused accept explains itself in plain words', async () => {
  const { serverNow, offer } = offerAt(300);
  const { ApiError } = await import('../../lib/api');
  api.mockImplementation(async (path: string) => {
    if (path.endsWith('/accept')) {
      throw new ApiError(409, { error: { code: 'CONFLICT', message: 'That seat offer ran out before it was taken, so it went to the next person. Nothing was charged.', requestId: 'r' } });
    }
    return { ...schedule, serverNow, offers: [offer], items: [] };
  });
  renderBook();
  fireEvent.click(await screen.findByRole('button', { name: 'Answer' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Take the seat' }));
  expect(await screen.findByText(/went to the next person\. Nothing was charged\./)).toBeInTheDocument();
});
