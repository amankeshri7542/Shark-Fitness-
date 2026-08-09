import { useEffect, useRef, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api';
import { enqueue } from '../lib/outbox';
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
 * appearing sent when it is not.
 */

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
  attachments: Array<{ name: string; url: string; failed: boolean }>;
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
}

export default function ConversationScreen() {
  const { conversationId } = useParams({ from: '/tabs/messages/$conversationId' });
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [queued, setQueued] = useState<Message[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [data?.items.length, queued.length]);

  // A queued message the server has since confirmed must not appear twice.
  useEffect(() => {
    if (!data) return;
    const confirmed = new Set(data.items.map((m) => m.clientId).filter(Boolean));
    setQueued((q) => q.filter((m) => !confirmed.has(m.clientId)));
  }, [data]);

  const send = (): void => {
    const body = draft.trim();
    if (!body || !data) return;

    const clientId = `msg-${conversationId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const optimistic: Message = {
      id: clientId,
      senderName: 'You',
      senderInitials: 'YOU',
      senderRole: 'member',
      fromMe: true,
      body,
      createdAt: new Date().toISOString(),
      relativeTime: 'just now',
      state: 'queued',
      attachments: [],
      clientId,
      safetyFlagged: false,
    };

    setDraft('');
    setQueued((q) => [...q, optimistic]);
    setSendError(null);

    void enqueue({
      clientId,
      kind: 'message-send',
      method: 'POST',
      path: `/member/messages/${conversationId}`,
      body: { clientId, body, attachments: [] },
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
                    <p key={a.name} className="mt-1.5 text-[12px] text-foam-50">
                      {/* An attachment with no url never reached storage; saying
                          so beats rendering a dead link. */}
                      {a.failed ? `${a.name} — did not upload` : a.name}
                    </p>
                  ))}
                </Panel>

                <span className="font-utility text-[9px] uppercase tracking-[0.1em] text-foam-35">
                  {message.state === 'queued' ? 'Queued — sends when you are back online' : message.relativeTime}
                  {message.fromMe && message.state === 'read' ? ' · read' : ''}
                </span>
              </div>
            ))
          )}
          <div ref={endRef} />
        </div>
      </div>

      {/* — Composer ——————————————————————————————————————————— */}
      <div className="sf-safe-bottom flex-none border-t border-line bg-hull p-3">
        {sendError ? <p className="mb-2 text-[12px] text-chum">{sendError}</p> : null}
        <div className="flex items-end gap-2">
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
