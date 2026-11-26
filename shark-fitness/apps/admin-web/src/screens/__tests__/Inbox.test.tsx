import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, api: apiMock };
});

import InboxScreen, { type InboxItem, type InboxThread } from '../Inbox';
import { ApiError } from '../../lib/api';
import { refuse, renderScreen, setOnline, signInAs } from '../../test/harness';

const item: InboxItem = {
  id: 'cnv_1',
  kind: 'reception',
  kindLabel: 'Front desk',
  topic: 'booking',
  title: 'Front desk · Classes and bookings',
  state: 'open',
  member: { id: 'mbr_1', name: 'Aman Mehra', initials: 'AM', memberNo: 'SF-40219', minor: false },
  assignee: null,
  lastMessage: 'Is the steam room open on Sunday?',
  lastFromMember: true,
  lastMessageRelative: '5m',
  unread: 1,
  needsReply: true,
  safetyFlagged: false,
};

const thread: InboxThread = {
  conversation: {
    id: 'cnv_1',
    kindLabel: 'Front desk',
    title: 'Front desk · Classes and bookings',
    state: 'open',
    assignee: null,
    member: { id: 'mbr_1', name: 'Aman Mehra', memberNo: 'SF-40219', minor: false },
    unread: 0,
  },
  messages: [
    { id: 'm1', senderName: 'Aman Mehra', fromMember: true, fromMe: false, body: 'Is the steam room open on Sunday?', relativeTime: '5m', readByMember: null, safetyFlagged: false, attachments: [] },
  ],
  notes: [{ id: 'n1', authorName: 'Priya', body: 'Asked about this last week too.', relativeTime: '2d' }],
  assignable: [{ staffId: 'stf_desk', name: 'Priya Rao', roleLabel: 'Front desk' }],
  notesPrivacy: 'Notes are only visible to staff. The member never sees them.',
};

const screens = [
  {
    path: '/inbox',
    component: InboxScreen,
    validateSearch: (s: Record<string, unknown>) => (typeof s.conversation === 'string' ? { conversation: s.conversation } : {}),
  },
];

beforeEach(() => {
  apiMock.mockReset();
  setOnline(true);
  signInAs('reception');
});
afterEach(() => setOnline(true));

describe('Inbox states', () => {
  it('shows a permission state to a role without the inbox', async () => {
    signInAs('accountant');
    renderScreen('/inbox', screens);
    expect(await screen.findByText('Not available to your role')).toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('shows loading, then an empty inbox', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    apiMock.mockReturnValue(new Promise((r) => (resolve = r)));
    renderScreen('/inbox', screens);
    expect(await screen.findByLabelText('Loading conversations')).toBeInTheDocument();
    resolve({ items: [], counts: { unread: 0, needsReply: 0 } });
    expect(await screen.findByText('Nobody is waiting')).toBeInTheDocument();
  });

  it('says a failed read is not an empty inbox', async () => {
    apiMock.mockImplementation(() => refuse(new Error('down')));
    renderScreen('/inbox', screens);
    expect(await screen.findByText('Could not load conversations')).toBeInTheDocument();
    expect(screen.getByText(/This is not an empty inbox/)).toBeInTheDocument();
  });

  it('warns when offline and keeps the reply button off', async () => {
    setOnline(false);
    apiMock.mockImplementation((path: string) =>
      path.startsWith('/admin/inbox?') ? Promise.resolve({ items: [item], counts: { unread: 1, needsReply: 1 } }) : Promise.resolve(thread),
    );
    renderScreen('/inbox?conversation=cnv_1', screens);
    expect(await screen.findByText(/Offline\. Replies and notes will not send/)).toBeInTheDocument();
    await screen.findByText('Notes for the team');
    expect(screen.getByRole('button', { name: 'Send reply' })).toBeDisabled();
  });
});

describe('Working a thread', () => {
  it('lists who is waiting and opens the thread with private notes beside it', async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation((path: string, options?: { method?: string; body?: unknown }) => {
      if (path.startsWith('/admin/inbox?')) return Promise.resolve({ items: [item], counts: { unread: 1, needsReply: 1 } });
      if (path === '/admin/inbox/cnv_1') return Promise.resolve(thread);
      if (path === '/admin/inbox/cnv_1/reply') return Promise.resolve({ messageId: 'm2', duplicate: false });
      if (path === '/admin/inbox/cnv_1/notes') return Promise.resolve({ noteId: 'n2' });
      if (path === '/admin/inbox/cnv_1/assign') return Promise.resolve({ ok: true, assignedStaffId: (options?.body as { staffId: string }).staffId });
      return Promise.resolve({ ok: true });
    });
    const { router } = renderScreen('/inbox', screens);

    expect(await screen.findByText('1 waiting for a reply')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Aman Mehra/ }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ conversation: 'cnv_1' }));

    const notes = await screen.findByRole('complementary', { name: 'Internal notes' });
    expect(within(notes).getByText('Notes are only visible to staff. The member never sees them.')).toBeInTheDocument();
    expect(within(notes).getByText('Asked about this last week too.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Reply to the member'), 'Yes, 7am to 1pm.');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/admin/inbox/cnv_1/reply', expect.objectContaining({ method: 'POST', body: expect.objectContaining({ body: 'Yes, 7am to 1pm.' }) })),
    );

    await user.type(within(notes).getByLabelText('Add a note'), 'Called back');
    await user.click(within(notes).getByRole('button', { name: 'Save note' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/admin/inbox/cnv_1/notes', { method: 'POST', body: { body: 'Called back' } }));

    await user.selectOptions(screen.getByLabelText('Assigned to'), 'stf_desk');
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/admin/inbox/cnv_1/assign', { method: 'POST', body: { staffId: 'stf_desk' } }));
  });

  it('says why a reply did not send', async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation((path: string) => {
      if (path.startsWith('/admin/inbox?')) return Promise.resolve({ items: [item], counts: { unread: 0, needsReply: 1 } });
      if (path === '/admin/inbox/cnv_1') return Promise.resolve(thread);
      if (path === '/admin/inbox/cnv_1/reply') {
        return refuse(new ApiError(403, { error: { code: 'FORBIDDEN', message: 'Direct messages between staff and members under 18 are switched off at this gym.', requestId: 'r' } }));
      }
      return Promise.resolve({ ok: true });
    });
    renderScreen('/inbox?conversation=cnv_1', screens);
    await user.type(await screen.findByLabelText('Reply to the member'), 'Hello');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('members under 18 are switched off');
  });
});
