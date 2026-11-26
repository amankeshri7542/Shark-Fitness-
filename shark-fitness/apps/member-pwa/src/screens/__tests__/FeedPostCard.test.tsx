import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => vi.fn());
// The spy returns an Error for a refusal and this wrapper turns it into the
// rejection, so the spy never holds a rejected promise of its own.
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  api: (...args: unknown[]) => {
    const result = apiMock(...args);
    return result instanceof Error ? Promise.reject(result) : result;
  },
}));

import { ApiError } from '../../lib/api';
import { FeedPostCard, type FeedPost } from '../pack/FeedPostCard';

const base: FeedPost = {
  id: 'pst_1',
  authorId: 'mbr_2',
  authorName: 'Rohit S.',
  authorInitials: 'RS',
  authorKind: 'member',
  isMine: false,
  kind: 'text',
  badge: null,
  body: 'New 5k PB on the rower!',
  removed: false,
  removedNote: null,
  moderationNote: null,
  relativeTime: '2h',
  kudos: 3,
  kudosByMe: false,
  commentCount: 1,
  comments: [
    { id: 'cmt_1', authorName: 'Neha P.', authorInitials: 'NP', body: 'Nice one', removed: false, relativeTime: '1h', canDelete: false, canReport: true },
  ],
  canBlock: true,
  canMute: true,
  canComment: true,
  canReport: true,
};

function renderCard(post: FeedPost, onChanged = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <FeedPostCard post={post} onChanged={onChanged} onKudos={vi.fn()} />
    </QueryClientProvider>,
  );
  return { onChanged };
}

beforeEach(() => apiMock.mockReset());

describe('Feed post', () => {
  it('opens comments and posts a reply', async () => {
    apiMock.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    const { onChanged } = renderCard(base);
    await user.click(screen.getByRole('button', { name: '1 comment' }));
    expect(screen.getByText('Nice one')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Write a comment'), 'Congrats!');
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/member/engagement/feed/pst_1/comment', { method: 'POST', body: { body: 'Congrats!' } }));
    expect(onChanged).toHaveBeenCalled();
  });

  it('reports with a reason and says who reads it', async () => {
    apiMock.mockResolvedValue({ message: 'Reported. A person from the gym team reads every report.' });
    const user = userEvent.setup();
    renderCard(base);
    await user.click(screen.getByRole('button', { name: 'Report' }));
    expect(screen.getByText(/A person on the team reads every report/)).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox'), 'spam');
    await user.click(screen.getByRole('button', { name: 'Send report' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/member/engagement/report', { method: 'POST', body: { targetType: 'post', targetId: 'pst_1', reason: 'spam' } }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Reported.');
  });

  it('explains that blocking is two-way before it blocks', async () => {
    apiMock.mockResolvedValue({ message: 'Blocked.' });
    const user = userEvent.setup();
    renderCard(base);
    await user.click(screen.getByRole('button', { name: 'Block' }));
    expect(screen.getByText(/You will not see each other's posts or comments/)).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Block' }).at(-1)!);
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/member/engagement/block/mbr_2', { method: 'POST' }));
  });

  it('mutes one way', async () => {
    apiMock.mockResolvedValue({ message: 'Muted.' });
    const user = userEvent.setup();
    renderCard(base);
    await user.click(screen.getByRole('button', { name: 'Mute' }));
    expect(screen.getByText(/They are not told and can still see yours/)).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Mute' }).at(-1)!);
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/member/engagement/mute/mbr_2', { method: 'POST' }));
  });

  it('shows a removed post as a tombstone and a held-back post with its reason', () => {
    renderCard({ ...base, id: 'a', removed: true, body: '', removedNote: 'This post was removed after a moderation review.' });
    expect(screen.getByText('This post was removed after a moderation review.')).toBeInTheDocument();
    renderCard({ ...base, id: 'b', isMine: true, canBlock: false, canMute: false, moderationNote: 'Waiting for a moderator. Only you can see it until it is approved.' });
    expect(screen.getByRole('note')).toHaveTextContent('Waiting for a moderator');
  });

  it('says plainly when the comment budget is spent', async () => {
    apiMock.mockReturnValue(new ApiError(429, { error: { code: 'RATE_LIMITED', message: 'Too many', requestId: 'r', retryAfterSec: 60 } }));
    const user = userEvent.setup();
    renderCard(base);
    await user.click(screen.getByRole('button', { name: '1 comment' }));
    await user.type(screen.getByLabelText('Write a comment'), 'again');
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You have commented a lot in the last few minutes');
  });
});
