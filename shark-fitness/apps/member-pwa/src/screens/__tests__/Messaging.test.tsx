import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => vi.fn());
const uploadMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const outboxState = vi.hoisted(() => ({ entries: [] as unknown[] }));
const enqueueMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => navigateMock,
  useParams: () => ({ conversationId: 'cnv_1' }),
}));
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  api: apiMock,
  uploadFile: uploadMock,
}));
vi.mock('../../lib/outbox', () => ({
  enqueue: enqueueMock,
  discard: vi.fn(),
  retryAll: vi.fn(),
  useOutbox: () => ({ entries: outboxState.entries, refresh: () => undefined }),
}));

import { ApiError, OfflineError } from '../../lib/api';
import NewMessageScreen, { type StartOptions } from '../NewMessage';
import ConversationScreen from '../Conversation';

const start: StartOptions = {
  topics: [
    { key: 'booking', label: 'Classes and bookings' },
    { key: 'other', label: 'Something else' },
  ],
  blocked: false,
  blockedReason: null,
  coach: { available: true, name: 'Rehan Khan', responseWindow: 'Replies usually within a few hours, 9am–9pm', outsideHours: false, outsideNote: null },
  coachMissingNote: null,
  desk: {
    available: true,
    name: 'Koramangala front desk',
    responseWindow: 'Replies usually within an hour, 6am–11pm',
    outsideHours: true,
    outsideNote: 'It is outside 6am–11pm. Your message is saved and answered from 6am tomorrow.',
  },
};

function renderWith(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  // jsdom has no layout, so no scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn();
  apiMock.mockReset();
  uploadMock.mockReset();
  navigateMock.mockReset();
  enqueueMock.mockClear();
  outboxState.entries = [];
});

describe('New message', () => {
  it('shows a loading state, then who replies when, and the outside-hours note for the chosen person', async () => {
    apiMock.mockResolvedValue({ start });
    const user = userEvent.setup();
    renderWith(<NewMessageScreen />);
    expect(document.querySelector('.sf-skeleton')).not.toBeNull();

    await user.click(await screen.findByRole('radio', { name: /Koramangala front desk/ }));
    expect(screen.getByRole('status')).toHaveTextContent('answered from 6am tomorrow');
    await user.click(screen.getByRole('radio', { name: /Rehan Khan/ }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('sends the start and opens the new thread', async () => {
    apiMock.mockImplementation((path: string, options?: { body?: unknown }) => {
      if (path === '/member/messages') return Promise.resolve({ start });
      if (path === '/member/messages/start') {
        expect(options?.body).toMatchObject({ to: 'coach', topic: 'booking', body: 'Can I move Thursday?' });
        return Promise.resolve({ conversationId: 'cnv_new' });
      }
      throw new Error(path);
    });
    const user = userEvent.setup();
    renderWith(<NewMessageScreen />);
    await user.click(await screen.findByRole('radio', { name: /Rehan Khan/ }));
    await user.selectOptions(screen.getByRole('combobox'), 'booking');
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    await user.type(screen.getByRole('textbox'), 'Can I move Thursday?');
    await user.click(send);
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: '/messages/$conversationId', params: { conversationId: 'cnv_new' } }));
  });

  it('keeps the message and says so when offline', async () => {
    apiMock.mockImplementation((path: string) =>
      path === '/member/messages' ? Promise.resolve({ start }) : Promise.reject(new OfflineError()),
    );
    const user = userEvent.setup();
    renderWith(<NewMessageScreen />);
    await user.click(await screen.findByRole('radio', { name: /front desk/ }));
    await user.selectOptions(screen.getByRole('combobox'), 'other');
    await user.type(screen.getByRole('textbox'), 'Lost my bottle');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You are offline. Your message is still here');
    expect(screen.getByRole('textbox')).toHaveValue('Lost my bottle');
  });

  it('explains when a minor cannot message staff (permission state)', async () => {
    apiMock.mockResolvedValue({ start: { ...start, blocked: true, blockedReason: 'Direct messages between staff and members under 18 are switched off at this gym.' } });
    renderWith(<NewMessageScreen />);
    expect(await screen.findByText('Messages are not available')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('shows an error state with retry when the options cannot load', async () => {
    apiMock.mockRejectedValue(new ApiError(500, { error: { code: 'INTERNAL', message: 'x', requestId: 'req_1' } }));
    renderWith(<NewMessageScreen />);
    expect(await screen.findByText('Could not open a new message')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

const thread = {
  conversation: {
    id: 'cnv_1',
    title: 'Front desk',
    counterpartName: 'Koramangala front desk',
    counterpartRole: 'reception',
    muted: false,
    state: 'open',
    responseWindow: 'within an hour',
    hoursLabel: '6am–11pm',
    outsideHours: false,
    outsideNote: null,
    safetyNotice: null,
    ticket: null,
  },
  items: [
    {
      id: 'msg_1',
      senderName: 'Priya',
      senderInitials: 'PR',
      senderRole: 'reception',
      fromMe: false,
      body: 'Here is the form.',
      createdAt: '2026-11-26T08:00:00Z',
      relativeTime: '1h',
      state: 'read',
      attachments: [
        { id: 'att_1', name: 'locker-form.pdf', mimeType: 'application/pdf', url: '/v1/attachments/att_1?exp=1&sig=x', failed: false },
        { id: 'att_2', name: 'map.jpg', mimeType: 'image/jpeg', url: '/v1/attachments/att_2?exp=1&sig=y', failed: false },
      ],
      clientId: null,
      safetyFlagged: false,
    },
  ],
  unread: 0,
  attachments: { enabled: true, maxSizeMb: 10, accept: ['image/jpeg', 'application/pdf'], reason: null },
};

describe('Conversation', () => {
  it('shows a queued message from the outbox, so it survives leaving and coming back', async () => {
    apiMock.mockResolvedValue(thread);
    outboxState.entries = [
      {
        key: 'u:c1',
        ownerKey: 'u',
        clientId: 'msg-cnv_1-1',
        kind: 'message-send',
        method: 'POST',
        path: '/member/messages/cnv_1',
        body: { clientId: 'msg-cnv_1-1', body: 'Sent from the basement', attachmentNames: [] },
        createdAt: Date.now(),
        attempts: 0,
        status: 'queued',
        nextAttemptAt: 0,
      },
    ];
    const first = renderWith(<ConversationScreen />);
    expect(await screen.findByText('Sent from the basement')).toBeInTheDocument();
    expect(screen.getByText('Queued — sends when you are back online')).toBeInTheDocument();
    first.unmount();

    renderWith(<ConversationScreen />);
    expect(await screen.findByText('Sent from the basement')).toBeInTheDocument();
  });

  it('renders photos inline and documents as downloads, and attaches a file before sending', async () => {
    apiMock.mockResolvedValue(thread);
    uploadMock.mockResolvedValue({ attachment: { id: 'att_9', name: 'knee.jpg', mimeType: 'image/jpeg', url: '/v1/attachments/att_9?exp=1&sig=z', failed: false } });
    const user = userEvent.setup();
    renderWith(<ConversationScreen />);

    expect(await screen.findByRole('img', { name: 'map.jpg' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /locker-form\.pdf/ })).toHaveAttribute('href', '/v1/attachments/att_1?exp=1&sig=x');

    const input = document.getElementById('attach-file') as HTMLInputElement;
    await user.upload(input, new File(['x'], 'knee.jpg', { type: 'image/jpeg' }));
    expect(await screen.findByRole('list', { name: 'Files to send' })).toHaveTextContent('knee.jpg');

    await user.type(screen.getByLabelText('Message'), 'This is the swelling');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ body: 'This is the swelling', attachmentIds: ['att_9'] }) }),
    );
  });

  it('says why an upload was refused', async () => {
    apiMock.mockResolvedValue(thread);
    uploadMock.mockRejectedValue(new ApiError(413, { error: { code: 'PAYLOAD_TOO_LARGE', message: 'That file is over 10 MB.', requestId: 'r' } }));
    const user = userEvent.setup();
    renderWith(<ConversationScreen />);
    await screen.findByText('Here is the form.');
    await user.upload(document.getElementById('attach-file') as HTMLInputElement, new File(['x'], 'big.jpg', { type: 'image/jpeg' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That file is over 10 MB.');
  });

  it('hides the paperclip when the server cannot store files', async () => {
    apiMock.mockResolvedValue({ ...thread, attachments: { enabled: false, maxSizeMb: 0, accept: [], reason: 'Not on this server.' } });
    renderWith(<ConversationScreen />);
    await screen.findByText('Here is the form.');
    expect(screen.queryByLabelText('Attach a photo or PDF')).toBeNull();
  });
});
