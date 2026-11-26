import { useEffect, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_ORIGIN, ApiError, OfflineError, api } from '../lib/api';
import { useBranchScope, usePermission } from '../lib/store';
import { useOnline } from '../lib/realtime';
import { Page } from '../ui/shell';
import {
  Button,
  Chip,
  EmptyState,
  ErrorState,
  Label,
  Panel,
  PermissionState,
  SearchField,
  Segmented,
  SelectField,
  Skeleton,
  TextAreaField,
  cx,
} from '../ui/console';

/* ============================================================================
   Inbox — member conversations with a coach or the front desk (P07).

   The list on the left is "who is waiting on us"; the thread on the right is
   one member, with the staff-only notes beside the replies. Notes are said to
   be private where they are written, because the cost of a coach believing a
   note went to the member — or the reverse — is a real one.

   Plain register throughout: this is a support surface.
   ========================================================================= */

type Filter = 'all' | 'mine' | 'unassigned' | 'unread' | 'closed';

export interface InboxItem {
  id: string;
  kind: 'coach' | 'reception';
  kindLabel: string;
  topic: string | null;
  title: string;
  state: string;
  member: { id: string; name: string; initials: string; memberNo: string; minor: boolean };
  assignee: { staffId: string; name: string } | null;
  lastMessage: string;
  lastFromMember: boolean;
  lastMessageRelative: string;
  unread: number;
  needsReply: boolean;
  safetyFlagged: boolean;
}

interface InboxList {
  items: InboxItem[];
  counts: { unread: number; needsReply: number };
}

interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  url: string;
}

export interface InboxThread {
  conversation: {
    id: string;
    kindLabel: string;
    title: string;
    state: string;
    assignee: { staffId: string; name: string } | null;
    member: { id: string; name: string; memberNo: string; minor: boolean };
    unread: number;
  };
  messages: Array<{
    id: string;
    senderName: string;
    fromMember: boolean;
    fromMe: boolean;
    body: string;
    relativeTime: string;
    readByMember: boolean | null;
    safetyFlagged: boolean;
    attachments: Attachment[];
  }>;
  notes: Array<{ id: string; authorName: string; body: string; relativeTime: string }>;
  assignable: Array<{ staffId: string; name: string; roleLabel: string }>;
  notesPrivacy: string;
}

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: 'Open' },
  { value: 'mine', label: 'Mine' },
  { value: 'unassigned', label: 'Unassigned' },
  { value: 'unread', label: 'Unread' },
  { value: 'closed', label: 'Closed' },
];

function failureText(error: unknown, fallback: string): string {
  if (error instanceof OfflineError) return 'No connection. Nothing was sent.';
  if (error instanceof ApiError) return error.message;
  return fallback;
}

export default function InboxScreen() {
  const canView = usePermission('inbox.view');
  const { branchId, branchName } = useBranchScope();
  const online = useOnline();
  const search = useSearch({ strict: false }) as { conversation?: string };
  const navigate = useNavigate();
  const openId = search.conversation ?? null;
  const setOpen = (conversationId: string | null): void => {
    void navigate({ to: '/inbox', search: conversationId ? { conversation: conversationId } : {}, replace: true });
  };

  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');

  const params = new URLSearchParams({ filter });
  if (q.trim()) params.set('q', q.trim());
  const list = useQuery({
    queryKey: ['inbox', branchId, filter, q.trim()],
    queryFn: () => api<InboxList>(`/admin/inbox?${params.toString()}`),
    enabled: canView,
    refetchInterval: 30_000,
  });

  if (!canView) {
    return (
      <Page title="Inbox">
        <PermissionState what="Member conversations" />
      </Page>
    );
  }

  return (
    <Page
      title="Inbox"
      kicker={branchName}
      actions={
        <div className="flex items-center gap-2">
          {list.data && list.data.counts.needsReply > 0 ? <Chip tone="warn">{list.data.counts.needsReply} waiting for a reply</Chip> : null}
          {!online ? <Chip tone="bad">Offline</Chip> : null}
        </div>
      }
    >
      {!online ? (
        <Panel tone="warn" className="p-3">
          <p className="text-[13px] text-foam-80">Offline. Replies and notes will not send until the connection is back.</p>
        </Panel>
      ) : null}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(280px,380px)_1fr]">
        <section aria-label="Conversations" className="flex min-h-0 flex-col border-r border-line">
          <div className="flex flex-col gap-2 border-b border-line p-3">
            <Segmented label="Show" options={FILTERS} value={filter} onChange={setFilter} />
            <SearchField label="Search conversations" placeholder="Member or subject" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {list.isPending ? (
              <div className="flex flex-col gap-2 p-3" aria-label="Loading conversations">
                {Array.from({ length: 5 }, (_, i) => (
                  <Skeleton key={i} className="h-16" />
                ))}
              </div>
            ) : list.isError ? (
              <ErrorState
                title="Could not load conversations"
                body="This is not an empty inbox — members may be waiting. Try again."
                onRetry={() => void list.refetch()}
              />
            ) : list.data.items.length === 0 ? (
              <EmptyState
                title={filter === 'closed' ? 'No closed conversations' : 'Nobody is waiting'}
                body={
                  filter === 'mine'
                    ? 'No conversation is assigned to you. Unassigned threads are under Unassigned.'
                    : 'Messages members send to their coach or the front desk appear here.'
                }
              />
            ) : (
              <ul>
                {list.data.items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => setOpen(item.id)}
                      aria-current={openId === item.id ? 'true' : undefined}
                      className={cx(
                        'flex w-full flex-col gap-1 border-b border-line-10 px-3.5 py-3 text-left hover:bg-wash-sonar-soft',
                        openId === item.id && 'bg-wash-sonar',
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <span className={cx('truncate text-[13px]', item.unread > 0 ? 'font-semibold text-foam' : 'text-foam-80')}>
                          {item.member.name}
                        </span>
                        <span className="flex-1" />
                        <span className="font-utility text-[10px] text-foam-50">{item.lastMessageRelative}</span>
                      </span>
                      <span className="truncate text-[12px] text-foam-65">{item.lastMessage}</span>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <Chip tone="neutral">{item.kindLabel}</Chip>
                        {item.unread > 0 ? <Chip tone="accent">{item.unread} new</Chip> : null}
                        {item.safetyFlagged ? <Chip tone="bad">Needs a person</Chip> : null}
                        {item.member.minor ? <Chip tone="warn">Under 18</Chip> : null}
                        <span className="text-[11px] text-foam-50">{item.assignee ? item.assignee.name : 'Unassigned'}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section aria-label="Conversation" className="flex min-h-0 flex-col">
          {openId ? (
            <Thread key={openId} conversationId={openId} online={online} onClosed={() => setOpen(null)} />
          ) : (
            <EmptyState title="Choose a conversation" body="Pick a member on the left to read the thread, reply or leave a note for the team." />
          )}
        </section>
      </div>
    </Page>
  );
}

function Thread({ conversationId, online, onClosed }: { conversationId: string; online: boolean; onClosed: () => void }) {
  const queryClient = useQueryClient();
  const [reply, setReply] = useState('');
  const [note, setNote] = useState('');
  const [replyKey, setReplyKey] = useState(() => `reply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  const thread = useQuery({
    queryKey: ['inbox', 'thread', conversationId],
    queryFn: () => api<InboxThread>(`/admin/inbox/${conversationId}`),
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['inbox'] });
  };

  const markRead = useMutation({
    mutationFn: () => api(`/admin/inbox/${conversationId}/read`, { method: 'POST', body: {} }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['inbox'], exact: false, refetchType: 'none' }),
  });
  const unread = thread.data?.conversation.unread ?? 0;
  useEffect(() => {
    if (unread > 0) markRead.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, unread]);

  const sendReply = useMutation({
    mutationFn: () => api(`/admin/inbox/${conversationId}/reply`, { method: 'POST', body: { body: reply.trim(), clientId: replyKey } }),
    onSuccess: () => {
      setReply('');
      setReplyKey(`reply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      refresh();
    },
  });
  const addNote = useMutation({
    mutationFn: () => api(`/admin/inbox/${conversationId}/notes`, { method: 'POST', body: { body: note.trim() } }),
    onSuccess: () => {
      setNote('');
      refresh();
    },
  });
  const assign = useMutation({
    mutationFn: (staffId: string | null) => api(`/admin/inbox/${conversationId}/assign`, { method: 'POST', body: { staffId } }),
    onSuccess: refresh,
  });
  const setState = useMutation({
    mutationFn: (state: 'open' | 'closed') => api(`/admin/inbox/${conversationId}/state`, { method: 'POST', body: { state } }),
    onSuccess: (_r, state) => {
      refresh();
      if (state === 'closed') onClosed();
    },
  });

  if (thread.isPending) {
    return (
      <div className="flex flex-col gap-2 p-4" aria-label="Loading conversation">
        <Skeleton className="h-10" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
    );
  }
  if (thread.isError) {
    return (
      <ErrorState
        title="Could not open this conversation"
        body={thread.error instanceof ApiError && thread.error.status === 404 ? 'It is not in your inbox, or it was moved.' : 'Try again in a moment.'}
        onRetry={() => void thread.refetch()}
      />
    );
  }

  const { conversation, messages, notes, assignable, notesPrivacy } = thread.data;
  const closed = conversation.state === 'closed';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-end gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <Label>{conversation.kindLabel}</Label>
          <h2 className="mt-0.5 truncate text-[16px] text-foam">{conversation.member.name}</h2>
          <p className="text-[12px] text-foam-50">
            {conversation.member.memberNo} · {conversation.title}
          </p>
        </div>
        <span className="flex-1" />
        <SelectField
          label="Assigned to"
          className="min-w-[200px]"
          value={conversation.assignee?.staffId ?? ''}
          disabled={!online || assign.isPending}
          onChange={(e) => assign.mutate(e.target.value || null)}
        >
          <option value="">Unassigned</option>
          {assignable.map((s) => (
            <option key={s.staffId} value={s.staffId}>
              {s.name} · {s.roleLabel}
            </option>
          ))}
        </SelectField>
        <Button variant="outline" disabled={!online} pending={setState.isPending} onClick={() => setState.mutate(closed ? 'open' : 'closed')}>
          {closed ? 'Reopen' : 'Close'}
        </Button>
      </div>
      {assign.isError ? <p role="alert" className="px-4 pt-2 text-[12px] text-chum">{failureText(assign.error, 'Could not assign.')}</p> : null}

      <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[1fr_300px]">
        <div className="flex min-h-0 flex-col">
          <ol aria-label="Messages" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
            {messages.map((m) => (
              <li key={m.id} className={cx('flex max-w-[80%] flex-col gap-1', m.fromMember ? 'self-start' : 'self-end items-end')}>
                <span className="font-utility text-[10px] uppercase tracking-[0.12em] text-foam-50">{m.senderName}</span>
                <div className={cx('border px-3.5 py-2.5', m.fromMember ? 'border-line' : 'border-sonar bg-wash-sonar-soft')}>
                  <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{m.body}</p>
                  {m.attachments.map((a) =>
                    a.mimeType.startsWith('image/') ? (
                      <a key={a.id} href={`${API_ORIGIN}${a.url}`} target="_blank" rel="noreferrer" className="mt-2 block">
                        <img src={`${API_ORIGIN}${a.url}`} alt={a.name} className="max-h-48 border border-line" loading="lazy" />
                      </a>
                    ) : (
                      <a key={a.id} href={`${API_ORIGIN}${a.url}`} className="mt-1.5 block text-[12px] text-sonar underline">
                        {a.name}
                      </a>
                    ),
                  )}
                </div>
                <span className="text-[11px] text-foam-50">
                  {m.relativeTime}
                  {m.readByMember === true ? ' · read' : ''}
                  {m.safetyFlagged ? ' · flagged for a person' : ''}
                </span>
              </li>
            ))}
          </ol>
          <form
            className="flex flex-col gap-2 border-t border-line p-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (reply.trim() && online && !closed) sendReply.mutate();
            }}
          >
            <TextAreaField
              label="Reply to the member"
              rows={3}
              value={reply}
              maxLength={4000}
              disabled={closed}
              onChange={(e) => setReply(e.target.value)}
              placeholder={closed ? 'Reopen the conversation to reply.' : 'The member sees this.'}
            />
            {sendReply.isError ? <p role="alert" className="text-[12px] text-chum">{failureText(sendReply.error, 'The reply did not send.')}</p> : null}
            <div className="flex items-center gap-2">
              <span className="flex-1 text-[11px] text-foam-50">{conversation.member.minor ? 'This member is under 18.' : ''}</span>
              <Button type="submit" variant="cta" disabled={!reply.trim() || !online || closed} pending={sendReply.isPending} pendingLabel="Sending">
                Send reply
              </Button>
            </div>
          </form>
        </div>

        <aside aria-label="Internal notes" className="flex min-h-0 flex-col border-l border-line bg-hull">
          <div className="border-b border-line px-3.5 py-2.5">
            <Label>Notes for the team</Label>
            <p className="mt-1 text-[11px] leading-relaxed text-foam-50">{notesPrivacy}</p>
          </div>
          <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
            {notes.length === 0 ? <li className="text-[12px] text-foam-50">No notes yet.</li> : null}
            {notes.map((n) => (
              <li key={n.id} className="border border-line-10 bg-panel p-2.5">
                <p className="whitespace-pre-wrap text-[12px] leading-relaxed">{n.body}</p>
                <p className="mt-1 text-[11px] text-foam-50">
                  {n.authorName} · {n.relativeTime}
                </p>
              </li>
            ))}
          </ul>
          <form
            className="flex flex-col gap-2 border-t border-line p-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (note.trim() && online) addNote.mutate();
            }}
          >
            <TextAreaField label="Add a note" rows={2} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} placeholder="Only staff see this." />
            {addNote.isError ? <p role="alert" className="text-[12px] text-chum">{failureText(addNote.error, 'The note was not saved.')}</p> : null}
            <Button type="submit" variant="outline" disabled={!note.trim() || !online} pending={addNote.isPending} pendingLabel="Saving">
              Save note
            </Button>
          </form>
        </aside>
      </div>
    </div>
  );
}
