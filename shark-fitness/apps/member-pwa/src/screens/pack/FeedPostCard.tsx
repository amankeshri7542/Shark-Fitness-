import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError, OfflineError, api } from '../../lib/api';
import { Button, Chip, Panel, cx } from '../../ui/primitives';

/**
 * One post in the gym feed, with its comments (PF-GAME-005, UX-M11).
 *
 * Moderation is never silent: a removed post leaves a tombstone, and a post
 * that is waiting for approval or was hidden shows its author why. Report,
 * mute and block are one tap away and each says what it does before it does
 * it — blocking in particular is two-way, and people should know that.
 */

export interface FeedComment {
  id: string;
  authorName: string;
  authorInitials: string;
  body: string;
  removed: boolean;
  moderationNote?: string | null;
  relativeTime: string;
  canDelete: boolean;
  canReport: boolean;
}

export interface FeedPost {
  id: string;
  authorId?: string | null;
  authorName: string;
  authorInitials: string;
  authorKind: 'member' | 'staff' | 'gym';
  isMine: boolean;
  kind: string;
  badge: string | null;
  body: string;
  removed: boolean;
  removedNote: string | null;
  moderationNote?: string | null;
  underReview?: boolean;
  relativeTime: string;
  kudos: number;
  kudosByMe: boolean;
  commentCount: number;
  comments?: FeedComment[];
  canBlock?: boolean;
  canMute?: boolean;
  canComment?: boolean;
  canReport?: boolean;
}

const REASONS: Array<{ value: string; label: string }> = [
  { value: 'harassment', label: 'Unkind or harassing' },
  { value: 'unsafe_advice', label: 'Unsafe advice' },
  { value: 'spam', label: 'Spam or selling' },
  { value: 'impersonation', label: 'Pretending to be someone' },
  { value: 'other', label: 'Something else' },
];

function messageOf(error: unknown): string {
  if (error instanceof OfflineError) return 'You are offline. Try again when you have signal.';
  if (error instanceof ApiError) {
    if (error.status === 429) return 'You have commented a lot in the last few minutes. Try again shortly.';
    return error.message;
  }
  return 'That did not go through. Try again.';
}

type Pending = null | { kind: 'report'; targetType: 'post' | 'comment'; targetId: string } | { kind: 'mute' } | { kind: 'block' };

export function FeedPostCard({ post, onChanged, onKudos }: { post: FeedPost; onChanged: () => void; onKudos: (on: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<Pending>(null);
  const [reason, setReason] = useState('harassment');
  const [notice, setNotice] = useState<string | null>(null);

  const comment = useMutation({
    mutationFn: () => api(`/member/engagement/feed/${post.id}/comment`, { method: 'POST', body: { body: draft.trim() } }),
    onSuccess: () => {
      setDraft('');
      onChanged();
    },
  });
  const deleteComment = useMutation({
    mutationFn: (commentId: string) => api(`/member/engagement/feed/${post.id}/comments/${commentId}`, { method: 'DELETE' }),
    onSuccess: onChanged,
  });
  const act = useMutation({
    mutationFn: async (action: NonNullable<Pending>) => {
      if (action.kind === 'report') {
        return api<{ message: string }>('/member/engagement/report', {
          method: 'POST',
          body: { targetType: action.targetType, targetId: action.targetId, reason },
        });
      }
      if (!post.authorId) throw new Error('No author');
      return api<{ message: string }>(`/member/engagement/${action.kind}/${post.authorId}`, { method: 'POST' });
    },
    onSuccess: (result) => {
      setNotice(result.message);
      setPending(null);
      onChanged();
    },
  });

  if (post.removed) {
    return (
      <Panel className="p-3">
        <p className="text-[12px] leading-relaxed text-foam-50">{post.removedNote ?? 'This post was removed by a moderator.'}</p>
      </Panel>
    );
  }

  const comments = post.comments ?? [];

  return (
    <Panel as="article" aria-label={`Post by ${post.authorName}`} className="p-3">
      {post.moderationNote ? (
        <p role="note" className="mb-2.5 border border-flare px-2.5 py-2 text-[12px] leading-relaxed text-flare">
          {post.moderationNote}
        </p>
      ) : null}
      <div className="flex items-center gap-2.5">
        <span
          className={cx(
            'grid h-8 w-8 flex-none place-items-center border font-utility text-[11px] font-semibold',
            post.authorKind === 'gym' ? 'border-line-accent text-sonar' : 'border-line-strong',
          )}
        >
          {post.authorInitials}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px]">
            {post.authorName}
            {post.authorKind === 'gym' ? <span className="ml-1.5 text-[11px] text-foam-50">· announcement</span> : null}
          </div>
          <div className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-50">{post.relativeTime}</div>
        </div>
        {post.underReview ? <Chip tone="warn">Under review</Chip> : null}
        {post.badge ? <Chip tone="accent" glyph={false}>{post.badge}</Chip> : null}
      </div>

      <p className="mt-2.5 text-[14px] leading-relaxed text-pretty">{post.body}</p>

      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line-10 pt-2.5">
        <button
          type="button"
          onClick={() => onKudos(!post.kudosByMe)}
          aria-pressed={post.kudosByMe}
          className={cx(
            'min-h-11 font-utility text-[11px] font-semibold uppercase tracking-[0.1em]',
            post.kudosByMe ? 'text-sonar' : 'text-foam-50 hover:text-foam',
          )}
        >
          <span aria-hidden="true">◆</span> {post.kudos} kudos
        </button>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="min-h-11 font-utility text-[11px] font-semibold uppercase tracking-[0.1em] text-foam-50 hover:text-foam"
        >
          {post.commentCount} comment{post.commentCount === 1 ? '' : 's'}
        </button>
        <span className="flex-1" />
        {!post.isMine && post.canReport !== false ? (
          <button type="button" className="min-h-11 text-[11px] text-foam-50 hover:text-chum" onClick={() => setPending({ kind: 'report', targetType: 'post', targetId: post.id })}>
            Report
          </button>
        ) : null}
        {post.canMute ? (
          <button type="button" className="min-h-11 text-[11px] text-foam-50 hover:text-foam" onClick={() => setPending({ kind: 'mute' })}>
            Mute
          </button>
        ) : null}
        {post.canBlock ? (
          <button type="button" className="min-h-11 text-[11px] text-foam-50 hover:text-chum" onClick={() => setPending({ kind: 'block' })}>
            Block
          </button>
        ) : null}
      </div>

      {pending ? (
        <div className="mt-2 flex flex-col gap-2 border border-line-strong p-2.5" role="group" aria-label="Confirm">
          {pending.kind === 'report' ? (
            <label className="flex flex-col gap-1">
              <span className="text-[12px] text-foam-65">What is wrong with it? A person on the team reads every report.</span>
              <select className="sf-field" value={reason} onChange={(e) => setReason(e.target.value)}>
                {REASONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="text-[12px] leading-relaxed text-foam-65">
              {pending.kind === 'mute'
                ? `Hide ${post.authorName}'s posts and comments from your feed? They are not told and can still see yours.`
                : `Block ${post.authorName}? You will not see each other's posts or comments, and you will appear to each other as "Blocked member" on leaderboards. They are not told.`}
            </p>
          )}
          {act.isError ? <p role="alert" className="text-[12px] text-chum">{messageOf(act.error)}</p> : null}
          <div className="flex gap-2">
            <Button size="sm" variant={pending.kind === 'mute' ? 'outline' : 'danger'} disabled={act.isPending} onClick={() => act.mutate(pending)}>
              {pending.kind === 'report' ? 'Send report' : pending.kind === 'mute' ? 'Mute' : 'Block'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="mt-2 text-[12px] leading-relaxed text-foam-65">
          {notice}
        </p>
      ) : null}

      {open ? (
        <div className="mt-2.5 flex flex-col gap-2">
          {comments.length === 0 ? <p className="text-[12px] text-foam-50">No comments yet.</p> : null}
          <ul className="flex flex-col gap-2">
            {comments.map((c) => (
              <li key={c.id} className="border-l-2 border-line-strong pl-2.5">
                {c.removed ? (
                  <p className="text-[12px] text-foam-50">{c.moderationNote ?? 'Removed by a moderator.'}</p>
                ) : (
                  <>
                    <p className="text-[12px] text-foam-50">
                      {c.authorName} · {c.relativeTime}
                    </p>
                    <p className="text-[13px] leading-relaxed">{c.body}</p>
                    {c.moderationNote ? <p className="text-[11px] text-flare">{c.moderationNote}</p> : null}
                    <span className="flex gap-3">
                      {c.canDelete ? (
                        <button type="button" className="min-h-9 text-[11px] text-foam-50 hover:text-chum" onClick={() => deleteComment.mutate(c.id)}>
                          Delete
                        </button>
                      ) : null}
                      {c.canReport ? (
                        <button
                          type="button"
                          className="min-h-9 text-[11px] text-foam-50 hover:text-chum"
                          onClick={() => setPending({ kind: 'report', targetType: 'comment', targetId: c.id })}
                        >
                          Report
                        </button>
                      ) : null}
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
          {post.canComment !== false ? (
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (draft.trim()) comment.mutate();
              }}
            >
              <label className="flex-1">
                <span className="sr-only">Write a comment</span>
                <input className="sf-field" value={draft} maxLength={400} onChange={(e) => setDraft(e.target.value)} placeholder="Write a comment" />
              </label>
              <Button type="submit" size="sm" variant="outline" disabled={!draft.trim() || comment.isPending}>
                Reply
              </Button>
            </form>
          ) : null}
          {comment.isError ? <p role="alert" className="text-[12px] text-chum">{messageOf(comment.error)}</p> : null}
        </div>
      ) : null}
    </Panel>
  );
}
