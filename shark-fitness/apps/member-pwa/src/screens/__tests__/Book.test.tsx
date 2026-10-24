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
