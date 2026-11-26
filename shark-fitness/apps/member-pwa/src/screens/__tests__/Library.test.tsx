import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/api')>()), api }));

import { ApiError } from '../../lib/api';
import LibraryScreen from '../Library';

const asset = (overrides: Record<string, unknown> = {}) => ({
  id: 'med_1',
  title: 'Hips and hamstrings flow',
  category: 'mobility',
  trainerName: 'Priya Nair',
  durationSec: 1200,
  durationLabel: '20 min',
  level: 'beginner',
  equipment: [],
  posterColor: '#0b2331',
  hasCaptions: true,
  publishedAt: '2026-10-01T00:00:00Z',
  playbackUrl: null,
  playable: false,
  blockedReason: 'no_video_allowance',
  blockedMessage: 'Streaming is not switched on for this gym yet. The plan and the coaching notes below are the useful part for now.',
  positionSec: 0,
  progressPct: 0,
  favourite: false,
  completedAt: null,
  ...overrides,
});

/** GET /member/media as routes/member/media.ts sends it. */
const payload = (overrides: Record<string, unknown> = {}) => ({
  streaming: {
    enabled: false,
    usedMinutes: 0,
    limitMinutes: 0,
    period: '2026-11',
    message: 'This gym has not switched on video streaming. Everything is listed with its plan, coach and kit so you can still follow along on the floor.',
  },
  filters: { category: 'all', level: 'all', favourites: false },
  categories: [
    { value: 'all', label: 'All', count: 3 },
    { value: 'mobility', label: 'mobility', count: 2 },
    { value: 'strength', label: 'strength', count: 1 },
  ],
  total: 3,
  items: [
    asset(),
    asset({ id: 'med_2', title: 'Kettlebell basics', category: 'strength', equipment: ['kettlebell'], level: 'intermediate', blockedReason: 'not_in_plan', blockedMessage: 'Your membership does not include this one. Reception can tell you what would.', favourite: true }),
    asset({ id: 'med_3', title: 'Desk-day reset', progressPct: 100, completedAt: '2026-11-20T08:00:00Z', positionSec: 1200 }),
  ],
  ...overrides,
});

function renderLibrary() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <LibraryScreen />
    </QueryClientProvider>,
  );
}

afterEach(() => api.mockReset());

describe('Library', () => {
  it('shows a loading skeleton first', () => {
    api.mockReturnValue(new Promise(() => undefined));
    const { container } = renderLibrary();
    expect(container.querySelector('.sf-skeleton')).not.toBeNull();
  });

  it('says once that streaming is off, then lists sessions with why each cannot play', async () => {
    api.mockResolvedValue(payload());
    renderLibrary();
    expect(await screen.findByText('Streaming is off')).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith('/member/media?category=all&level=all');
    expect(screen.getByText('3 sessions')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Hips and hamstrings flow' })).toBeInTheDocument();
    expect(screen.getAllByText('Priya Nair · 20 min · beginner')).toHaveLength(2);
    expect(screen.getByText('Your membership does not include this one. Reception can tell you what would.')).toBeInTheDocument();
    // A control that cannot work is never shown.
    expect(screen.queryByRole('button', { name: 'Play' })).not.toBeInTheDocument();
    expect(screen.getByText('Finished')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Kettlebell basics from saved' })).toBeInTheDocument();
  });

  it('a playable session opens its stream', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    api.mockResolvedValue(
      payload({ streaming: { enabled: true, usedMinutes: 10, limitMinutes: 600, period: '2026-11', message: null }, items: [asset({ playable: true, playbackUrl: 'https://stream.example/med_1.m3u8', blockedReason: null, blockedMessage: null })], total: 1 }),
    );
    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Play' }));
    expect(open).toHaveBeenCalledWith('https://stream.example/med_1.m3u8', '_blank', 'noopener');
    expect(screen.queryByText('Streaming is off')).not.toBeInTheDocument();
  });

  it('saving a session records it and refreshes the list', async () => {
    api.mockImplementation(async (path: string) => (path.endsWith('/progress') ? { ok: true } : payload()));
    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Save Hips and hamstrings flow' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/member/media/med_1/progress', { method: 'POST', body: { favourite: true } }));
    await waitFor(() => expect(api.mock.calls.filter(([path]) => path.startsWith('/member/media?')).length).toBeGreaterThan(1));
  });

  it('keeps the search box (and focus) while typing, and asks the server for the match', async () => {
    api.mockImplementation(async (path: string) =>
      path.includes('q=') ? payload({ items: [asset({ id: 'med_2', title: 'Kettlebell basics' })], total: 1 }) : payload(),
    );
    const user = userEvent.setup();
    renderLibrary();
    const search = await screen.findByLabelText('Search');
    await user.click(search);
    await user.type(search, 'kettle');
    expect(screen.getByLabelText('Search')).toHaveValue('kettle');
    expect(screen.getByLabelText('Search')).toHaveFocus();
    await waitFor(() => expect(api).toHaveBeenLastCalledWith('/member/media?category=all&level=all&q=kettle'));
    expect(await screen.findByText('1 sessions')).toBeInTheDocument();
  });

  it('filters by level and category', async () => {
    api.mockResolvedValue(payload());
    renderLibrary();
    fireEvent.click(await screen.findByRole('tab', { name: 'Hard' }));
    await waitFor(() => expect(api).toHaveBeenLastCalledWith('/member/media?category=all&level=advanced'));
    fireEvent.click(await screen.findByRole('button', { name: /^strength/ }));
    await waitFor(() => expect(api).toHaveBeenLastCalledWith('/member/media?category=strength&level=advanced'));
    expect(screen.getByRole('button', { name: /^strength/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('empty search: says nothing matches and how to widen it', async () => {
    api.mockResolvedValue(payload({ items: [], total: 0 }));
    renderLibrary();
    expect(await screen.findByRole('heading', { name: 'Nothing matches that' })).toBeInTheDocument();
    expect(screen.getByText('Nothing found')).toBeInTheDocument();
  });

  it('empty saved list: explains how to save one', async () => {
    api.mockImplementation(async (path: string) => (path.includes('favourites=true') ? payload({ items: [], total: 0 }) : payload()));
    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Saved' }));
    expect(await screen.findByRole('heading', { name: 'Nothing saved yet' })).toBeInTheDocument();
  });

  it('error: says saved sessions are safe and retries', async () => {
    api.mockRejectedValueOnce(new ApiError(502, { error: { code: 'INTERNAL', message: 'x', requestId: 'req_lib' } }));
    renderLibrary();
    expect(await screen.findByRole('heading', { name: 'Could not load the library' })).toBeInTheDocument();
    expect(screen.getByText('Ref req_lib')).toBeInTheDocument();
    api.mockResolvedValue(payload());
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('3 sessions')).toBeInTheDocument();
  });
});
