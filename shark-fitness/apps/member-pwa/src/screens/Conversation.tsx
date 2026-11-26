import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, OfflineError, api, mediaUrl, uploadFile } from '../lib/api';
import { discard, enqueue, retryAll, useOutbox, type OutboxEntry } from '../lib/outbox';
import { ScreenBody } from '../ui/shell';
import { Button, Chip, Display, ErrorState, Label, Panel, Skeleton, cx } from '../ui/primitives';

/**
 * One thread.
 *
 * Sending goes through the offline outbox: a member messaging from inside the
 * building often has no signal, and a lost message about an injury or a payment
 * is the worst possible thing to drop. The `clientId` is the idempotency key,
 * unique on (conversation, clientId), so an outbox replay is a no-op.
 *
 * A queued message is shown immediately and marked as such, rather than
 * appearing sent when it is not. Queued messages are read from the outbox
 * itself, not from this screen's state, so they are still on screen after the
 * member leaves the thread and comes back (P07: the old component-state copy
 * vanished on navigation while the message sat in the outbox).
 */

interface Attachment {
  id?: string;
  name: string;
  url?: string;
  mimeType?: string;
  sizeBytes?: number;
  failed: boolean;
}

interface AttachmentPolicy {
  enabled: boolean;
  maxSizeMb: number;
  accept: string[];
  reason: string | null;
}

interface Message {
  id: string;
  senderName: string;
  senderInitials: string;
  senderRole: string;
  fromMe: boolean;
  body: string;
  createdAt: string;
  relativeTime: string;
  state: string;
  attachments: Attachment[];
  clientId: string | null;
  safetyFlagged: boolean;
}

interface Payload {
  conversation: {
    id: string;
    title: string;
    counterpartName: string;
    counterpartRole: string;
    muted: boolean;
    state: string;
    responseWindow: string | null;
    hoursLabel: string | null;
    outsideHours: boolean;
    outsideNote: string | null;
    safetyNotice: string | null;
    ticket: { reference: string; state: string; slaLabel: string } | null;
  };
  items: Message[];
  unread: number;
  attachments?: AttachmentPolicy;
}

/** Outbox entries for this thread that the server has not confirmed yet. */
function queuedFrom(entries: OutboxEntry[], conversationId: string): Message[] {
  return entries
    .filter((e) => e.kind === 'message-send' && e.path === `/member/messages/${conversationId}` && e.status !== 'synced')
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((e) => {
      const body = (e.body ?? {}) as { body?: string; attachmentNames?: string[] };
      return {
        id: e.clientId,
        senderName: 'You',
        senderInitials: 'YOU',
        senderRole: 'member',
        fromMe: true,
        body: body.body ?? '',
        createdAt: new Date(e.createdAt).toISOString(),
        relativeTime: 'just now',
        state: e.status === 'failed' || e.status === 'conflict' ? 'failed' : 'queued',
        attachments: (body.attachmentNames ?? []).map((name) => ({ name, failed: false })),
        clientId: e.clientId,
        safetyFlagged: false,
      };
    });
}

export default function ConversationScreen() {
  const { conversationId } = useParams({ from: '/tabs/messages/$conversationId' });
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const { entries } = useOutbox();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => api<Payload>(`/member/messages/${conversationId}`),
  });

  const markRead = useMutation({
    mutationFn: () => api(`/member/messages/${conversationId}/read`, { method: 'POST', body: {} }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['messages'] });
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  // Opening the thread is reading it.
  useEffect(() => {
    if (data && data.unread > 0) markRead.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.conversation.id, data?.unread]);

  // A queued message the server has since confirmed must not appear twice.
  const queued = useMemo(() => {
    const confirmed = new Set((data?.items ?? []).map((m) => m.clientId).filter(Boolean));
    return queuedFrom(entries, conversationId).filter((m) => !confirmed.has(m.clientId));
  }, [entries, data, conversationId]);

  // The outbox deletes an entry once the server confirms it: when this
  // thread's backlog shrinks, read the thread again to show the real message.
  const backlog = entries.filter((e) => e.path === `/member/messages/${conversationId}`).length;
  const previousBacklog = useRef(backlog);
  useEffect(() => {
    if (backlog < previousBacklog.current) {
      void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] });
      void queryClient.invalidateQueries({ queryKey: ['messages'] });
    }
    previousBacklog.current = backlog;
  }, [backlog, conversationId, queryClient]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [data?.items.length, queued.length]);

  const attach = async (file: File): Promise<void> => {
    setUploadError(null);
    setUploading(true);
    try {
      const { attachment } = await uploadFile<{ attachment: Attachment }>(`/member/messages/${conversationId}/attachments`, file);
      setPendingFiles((files) => [...files, attachment]);
    } catch (error) {
      setUploadError(
        error instanceof OfflineError
          ? 'You are offline. Photos and files need a connection to attach.'
          : error instanceof ApiError
            ? error.message
            : 'That file did not upload. Try again.',
      );
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const send = (): void => {
    const body = draft.trim();
    if (!body || !data) return;

    const clientId = `msg-${conversationId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const files = pendingFiles.filter((f) => f.id);

    setDraft('');
    setPendingFiles([]);
    setSendError(null);

    void enqueue({
      clientId,
      kind: 'message-send',
      method: 'POST',
      path: `/member/messages/${conversationId}`,
      body: {
        clientId,
        body,
        attachmentIds: files.map((f) => f.id),
        // Not sent to the server (it ignores unknown keys); lets the queued
        // bubble name its files while it waits.
        attachmentNames: files.map((f) => f.name),
      },
    })
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] });
        void queryClient.invalidateQueries({ queryKey: ['messages'] });
      })
      .catch(() => setSendError('That message is saved on this device but could not be queued. Try sending again.'));
  };

  if (isLoading) {
    return (
      <ScreenBody>
        <div className="flex flex-col gap-3 p-4">
          <Skeleton className="h-14" />
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      </ScreenBody>
    );
  }

  if (error || !data) {
    return (
      <ScreenBody>
        <div className="p-4">
          <ErrorState
            title="Could not open this thread"
            body="Nothing you sent has been lost. Try again in a moment."
            onRetry={() => void refetch()}
            requestId={error instanceof ApiError ? error.requestId : undefined}
          />
        </div>
      </ScreenBody>
    );
  }

  const { conversation } = data;
  const thread = [...data.items, ...queued];

  return (
    <ScreenBody className="flex flex-col">
      {/* — Who you are talking to, and when they answer ————————— */}
      <div className="flex flex-none items-center gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <Display size="sm" as="h1" className="truncate">
            {conversation.counterpartName}
          </Display>
          <p className="mt-0.5 font-utility text-[10px] uppercase tracking-[0.12em] text-foam-35">
            {conversation.counterpartRole.replace(/_/g, ' ')}
            {conversation.responseWindow ? ` · replies ${conversation.responseWindow}` : ''}
          </p>
        </div>
        {conversation.ticket ? <Chip tone="warn">{conversation.ticket.reference}</Chip> : null}
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col gap-3 p-4">
          {conversation.safetyNotice ? (
            <Panel tone="warn" className="p-4">
              <Label>Someone is reading this</Label>
              <p className="mt-1.5 text-[13px] leading-relaxed text-foam-65">{conversation.safetyNotice}</p>
            </Panel>
          ) : null}

          {conversation.outsideHours && conversation.outsideNote ? (
            <Panel tone="warn" className="p-4">
              <p className="text-[13px] leading-relaxed text-foam-65">{conversation.outsideNote}</p>
            </Panel>
          ) : null}

          {thread.length === 0 ? (
            <Panel className="p-5">
              <p className="text-[13px] leading-relaxed text-foam-65">
                Nothing here yet. Write the first message below.
              </p>
            </Panel>
          ) : (
            thread.map((message) => (
              <div
                key={message.id}
                className={cx('flex max-w-[86%] flex-col gap-1', message.fromMe ? 'self-end items-end' : 'self-start')}
              >
                {!message.fromMe ? (
                  <span className="font-utility text-[10px] uppercase tracking-[0.12em] text-foam-35">
                    {message.senderName}
                  </span>
                ) : null}

                <Panel
                  tone={message.fromMe ? 'accent' : 'plain'}
                  className={cx('px-3.5 py-2.5', message.state === 'queued' && 'opacity-70')}
                >
                  <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{message.body}</p>

                  {message.attachments.map((a) => (
                    <AttachmentView key={a.id ?? a.name} attachment={a} />
                  ))}
                </Panel>

                <span className="font-utility text-[9px] uppercase tracking-[0.1em] text-foam-35">
                  {message.state === 'queued'
                    ? 'Queued — sends when you are back online'
                    : message.state === 'failed'
                      ? 'Not sent'
                      : message.relativeTime}
                  {message.fromMe && message.state === 'read' ? ' · read' : ''}
                </span>
                {message.state === 'failed' ? (
                  <span className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => void retryAll()}>
                      Try again
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void discard(message.clientId ?? message.id)}>
                      Discard
                    </Button>
                  </span>
                ) : null}
              </div>
            ))
          )}
          <div ref={endRef} />
        </div>
      </div>

      {/* — Composer ——————————————————————————————————————————— */}
      <div className="sf-safe-bottom flex-none border-t border-line bg-hull p-3">
        {sendError ? <p className="mb-2 text-[12px] text-chum">{sendError}</p> : null}
        {uploadError ? (
          <p role="alert" className="mb-2 text-[12px] text-chum">
            {uploadError}
          </p>
        ) : null}
        {pendingFiles.length > 0 ? (
          <ul aria-label="Files to send" className="mb-2 flex flex-wrap gap-2">
            {pendingFiles.map((f) => (
              <li key={f.id ?? f.name} className="flex items-center gap-1.5 border border-line-strong px-2 py-1 text-[12px]">
                <span className="max-w-[180px] truncate">{f.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${f.name}`}
                  className="min-h-8 min-w-8 text-foam-50 hover:text-chum"
                  onClick={() => setPendingFiles((files) => files.filter((x) => x !== f))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex items-end gap-2">
          {data.attachments?.enabled ? (
            <>
              <input
                ref={fileRef}
                type="file"
                accept={data.attachments.accept.join(',')}
                className="sr-only"
                id="attach-file"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void attach(file);
                }}
              />
              <label
                htmlFor="attach-file"
                aria-label="Attach a photo or PDF"
                className={cx(
                  'grid min-h-11 min-w-11 cursor-pointer place-items-center border border-line-strong text-[18px] text-foam-65 hover:border-sonar hover:text-sonar',
                  (uploading || pendingFiles.length >= 5) && 'pointer-events-none opacity-40',
                )}
              >
                {uploading ? '…' : '+'}
              </label>
            </>
          ) : null}
          <label className="flex-1">
            <span className="sr-only">Message</span>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={2}
              placeholder="Write a message"
              className="sf-field w-full resize-none"
            />
          </label>
          <Button variant="cta" disabled={draft.trim().length === 0} onClick={send}>
            Send
          </Button>
        </div>
      </div>
    </ScreenBody>
  );
}

/** A sent file: photos show inline, documents are a download link. */
function AttachmentView({ attachment }: { attachment: Attachment }) {
  // An attachment with no url never reached storage; saying so beats
  // rendering a dead link (UX-M12 "failed attachment").
  if (attachment.failed || !attachment.url) {
    return (
      <p className="mt-1.5 text-[12px] text-foam-50">{attachment.failed ? `${attachment.name} — did not upload` : attachment.name}</p>
    );
  }
  if (attachment.mimeType?.startsWith('image/')) {
    return (
      <a href={mediaUrl(attachment.url)} target="_blank" rel="noreferrer" className="mt-2 block">
        <img src={mediaUrl(attachment.url)} alt={attachment.name} className="max-h-56 max-w-full border border-line" loading="lazy" />
      </a>
    );
  }
  return (
    <a
      href={mediaUrl(attachment.url)}
      className="mt-1.5 inline-flex min-h-9 items-center gap-1.5 border border-line-strong px-2 text-[12px] text-foam hover:border-sonar hover:text-sonar"
    >
      <span aria-hidden="true">↓</span> {attachment.name}
    </a>
  );
}
