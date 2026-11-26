import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/api')>()), api }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, children, className }: { to: string; params?: Record<string, string>; children: React.ReactNode; className?: string }) => (
    <a href={Object.entries(params ?? {}).reduce((href, [key, value]) => href.replace(`$${key}`, value), to)} className={className}>
      {children}
    </a>
  ),
}));

import { ApiError } from '../../lib/api';
import MessagesScreen from '../Messages';

const conversation = (overrides: Record<string, unknown> = {}) => ({
  id: 'cnv_1',
  kind: 'coach',
  title: 'Coach',
  counterpartName: 'Rehan Khan',
  counterpartInitials: 'RK',
  counterpartRole: 'personal_trainer',
  lastMessage: 'See you Thursday at 7.',
  lastMessageFromMe: false,
  lastMessageRelative: '2h',
  lastMessageFlagged: false,
  unread: 0,
  muted: false,
  state: 'open',
  responseWindow: 'within a few hours',
  hoursLabel: '9am–9pm',
  outsideHours: false,
  outsideNote: null,
  ticket: null,
  ...overrides,
});

const payload = (overrides: Record<string, unknown> = {}) => ({
  items: [
    conversation({ unread: 2 }),
    conversation({
      id: 'cnv_2',
      kind: 'desk',
      counterpartName: 'Koramangala front desk',
      counterpartInitials: 'KF',
      counterpartRole: 'reception',
      lastMessage: 'Locker form attached',
      lastMessageFromMe: true,
      muted: true,
      ticket: { id: 'tkt_1', reference: 'SUP-0042', state: 'open', slaLabel: 'Due in 2h' },
    }),
  ],
  unreadTotal: 2,
  openTicketCount: 1,
  branch: { name: 'Koramangala Depot' },
  desk: { hoursLabel: '6am–11pm', outsideHours: false, outsideNote: null },
  ...overrides,
});

function renderMessages() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MessagesScreen />
    </QueryClientProvider>,
  );
}

afterEach(() => api.mockReset());

describe('Messages', () => {
  it('shows a loading skeleton first', () => {
    api.mockReturnValue(new Promise(() => undefined));
    const { container } = renderMessages();
    expect(container.querySelector('.sf-skeleton')).not.toBeNull();
  });

  it('lists each thread with who replies when, unread counts, muted and ticket chips', async () => {
    api.mockResolvedValue(payload());
    renderMessages();
    const coach = await screen.findByRole('link', { name: /Rehan Khan/ });
    expect(coach).toHaveAttribute('href', '/messages/cnv_1');
    expect(coach).toHaveTextContent('personal trainer · replies within a few hours');
    expect(coach).toHaveTextContent('2 new');
    expect(screen.getByText('2 unread')).toBeInTheDocument();
    const desk = screen.getByRole('link', { name: /front desk/ });
    expect(desk).toHaveAttribute('href', '/messages/cnv_2');
    expect(desk).toHaveTextContent('You: Locker form attached');
    expect(desk).toHaveTextContent('Muted');
    expect(desk).toHaveTextContent('SUP-0042');
    expect(screen.getByRole('link', { name: 'New message' })).toHaveAttribute('href', '/messages/new');
    expect(api).toHaveBeenCalledWith('/member/messages');
  });

  it('says when reception is closed before the member writes', async () => {
    api.mockResolvedValue(
      payload({ desk: { hoursLabel: '6am–11pm', outsideHours: true, outsideNote: 'Reception opens at 6am. Messages sent now are read then.' } }),
    );
    renderMessages();
    expect(await screen.findByText('Reception is closed')).toBeInTheDocument();
    expect(screen.getByText('Reception opens at 6am. Messages sent now are read then.')).toBeInTheDocument();
  });

  it('empty: an invitation to write, not a blank list', async () => {
    api.mockResolvedValue(payload({ items: [], unreadTotal: 0 }));
    renderMessages();
    expect(await screen.findByRole('heading', { name: 'No messages yet' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Write to the gym' })).toHaveAttribute('href', '/messages/new');
    expect(screen.getByText('Koramangala Depot · 0 threads')).toBeInTheDocument();
  });

  it('error: says nothing sent was lost, shows the reference, and retries', async () => {
    api.mockRejectedValueOnce(new ApiError(500, { error: { code: 'INTERNAL', message: 'boom', requestId: 'req_msg_1' } }));
    renderMessages();
    expect(await screen.findByRole('heading', { name: 'Could not load your messages' })).toBeInTheDocument();
    expect(screen.getByText('Ref req_msg_1')).toBeInTheDocument();
    api.mockResolvedValue(payload());
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: /Rehan Khan/ })).toBeInTheDocument();
  });
});
