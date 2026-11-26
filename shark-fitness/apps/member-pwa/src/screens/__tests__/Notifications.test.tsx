import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/api')>()), api }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, onClick }: { to: string; children: React.ReactNode; onClick?: (event: React.MouseEvent) => void }) => (
    <a
      href={to}
      onClick={(event) => {
        event.preventDefault();
        onClick?.(event);
      }}
    >
      {children}
    </a>
  ),
}));

import { ApiError } from '../../lib/api';
import NotificationsScreen from '../Notifications';

const item = (overrides: Record<string, unknown> = {}) => ({
  id: 'ntf_1',
  channel: 'in_app',
  title: 'Engine Room is cancelled',
  body: 'Rehan is unwell. Your class credit is back in your account.',
  createdAt: '2026-11-26T06:00:00Z',
  relativeTime: '1h',
  readAt: null,
  link: '/book',
  kind: 'session_cancelled',
  ...overrides,
});

const payload = () => ({
  items: [
    item(),
    item({ id: 'ntf_2', title: 'Payment received', body: '₹2,950 for Depot Monthly.', kind: 'payment_succeeded', readAt: '2026-11-25T10:00:00Z', link: null }),
    item({ id: 'ntf_3', title: 'Gym closes early', body: 'Closed from 6pm for maintenance.', kind: 'branch_notice', link: null }),
  ],
  unread: 2,
});

function renderScreen() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <NotificationsScreen />
    </QueryClientProvider>,
  );
}

const markCalls = () => api.mock.calls.filter(([path]) => path === '/me/notifications/read');

afterEach(() => api.mockReset());

describe('Notifications', () => {
  it('shows a loading skeleton first', () => {
    api.mockReturnValue(new Promise(() => undefined));
    const { container } = renderScreen();
    expect(container.querySelector('.sf-skeleton')).not.toBeNull();
  });

  it('lists each notification with a plain label for its kind; only ones that go somewhere are links', async () => {
    api.mockResolvedValue(payload());
    renderScreen();
    expect(await screen.findByText('2 unread')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Engine Room is cancelled/ })).toHaveAttribute('href', '/book');
    expect(screen.getByText('Class cancelled')).toBeInTheDocument();
    expect(screen.getByText('Payment')).toBeInTheDocument();
    // An unknown kind still gets a plain label.
    expect(screen.getByText('Update')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Payment received/ })).not.toBeInTheDocument();
    expect(api).toHaveBeenCalledWith('/me/notifications');
  });

  it('Mark all read sends one request for everything', async () => {
    api.mockImplementation(async (path: string) => (path === '/me/notifications/read' ? { marked: 2 } : payload()));
    renderScreen();
    fireEvent.click(await screen.findByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/me/notifications/read', { method: 'POST', body: {} }));
  });

  it('opening an unread linked notification marks it read exactly once', async () => {
    api.mockImplementation(async (path: string) => (path === '/me/notifications/read' ? { marked: 1 } : payload()));
    renderScreen();
    fireEvent.click(await screen.findByRole('heading', { name: 'Engine Room is cancelled' }));
    await waitFor(() => expect(markCalls()).toHaveLength(1));
    expect(markCalls()[0]![1]).toEqual({ method: 'POST', body: { ids: ['ntf_1'] } });
  });

  it('tapping an unread notification with no link marks it read', async () => {
    api.mockImplementation(async (path: string) => (path === '/me/notifications/read' ? { marked: 1 } : payload()));
    renderScreen();
    fireEvent.click(await screen.findByRole('heading', { name: 'Gym closes early' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/me/notifications/read', { method: 'POST', body: { ids: ['ntf_3'] } }));
  });

  it('all read: no Mark all read button', async () => {
    api.mockResolvedValue({ items: [item({ readAt: '2026-11-26T07:00:00Z' })], unread: 0 });
    renderScreen();
    expect(await screen.findByText('All read')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark all read' })).not.toBeInTheDocument();
  });

  it('empty: says what will show up here', async () => {
    api.mockResolvedValue({ items: [], unread: 0 });
    renderScreen();
    expect(await screen.findByRole('heading', { name: 'Nothing to read' })).toBeInTheDocument();
    expect(screen.getByText(/Class changes, waitlist offers/)).toBeInTheDocument();
  });

  it('error: says nothing was missed and retries', async () => {
    api.mockRejectedValueOnce(new ApiError(503, { error: { code: 'INTERNAL', message: 'down', requestId: 'req_ntf' } }));
    renderScreen();
    expect(await screen.findByRole('heading', { name: 'Could not load notifications' })).toBeInTheDocument();
    expect(screen.getByText('Ref req_ntf')).toBeInTheDocument();
    api.mockResolvedValue(payload());
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('2 unread')).toBeInTheDocument();
  });
});
