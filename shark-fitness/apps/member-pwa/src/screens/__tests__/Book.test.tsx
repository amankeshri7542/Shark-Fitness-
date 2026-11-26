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
