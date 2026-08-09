import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ApiError, api } from '../lib/api';
import { ScreenBody, Stack } from '../ui/shell';
import {
  Chip,
  Display,
  EmptyState,
  ErrorState,
  Label,
  Panel,
  SectionRule,
  Skeleton,
  cx,
} from '../ui/primitives';

/**
 * Conversations with the gym.
 *
 * Support copy is plain register throughout. The one thing this screen must get
 * right is expectation: a member who writes at 23:00 should know when someone
 * will read it, so the desk's hours and response window are stated on the list
 * rather than discovered after sending.
 */

interface Conversation {
  id: string;
  kind: string;
  title: string;
  counterpartName: string;
  counterpartInitials: string;
  counterpartRole: string;
  lastMessage: string;
  lastMessageFromMe: boolean;
  lastMessageRelative: string;
  lastMessageFlagged: boolean;
  unread: number;
  muted: boolean;
  state: string;
  responseWindow: string | null;
  hoursLabel: string | null;
  outsideHours: boolean;
  outsideNote: string | null;
  ticket: { id: string; reference: string; state: string; slaLabel: string } | null;
}

interface Payload {
  items: Conversation[];
  unreadTotal: number;
  openTicketCount: number;
  branch: { name: string };
  desk: { hoursLabel: string | null; outsideHours: boolean; outsideNote: string | null } | null;
}

export default function MessagesScreen() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['messages'],
    queryFn: () => api<Payload>('/member/messages'),
  });

  if (isLoading) {
    return (
      <ScreenBody>
        <Stack>
          <Skeleton className="h-14" />
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </Stack>
      </ScreenBody>
    );
  }

  if (error || !data) {
    return (
      <ScreenBody>
        <Stack>
          <ErrorState
            title="Could not load your messages"
            body="Nothing you sent has been lost. Try again in a moment."
            onRetry={() => void refetch()}
            requestId={error instanceof ApiError ? error.requestId : undefined}
          />
        </Stack>
      </ScreenBody>
    );
  }

  return (
    <ScreenBody>
      <Stack>
        {/* Said once. A member should know when to expect a reply before they
            write, not after. */}
        {data.desk?.outsideHours && data.desk.outsideNote ? (
          <Panel tone="warn" className="flex flex-col gap-1.5 p-4">
            <Label>Reception is closed</Label>
            <p className="text-[13px] leading-relaxed text-foam-65">{data.desk.outsideNote}</p>
          </Panel>
        ) : null}

        <SectionRule>
          {data.unreadTotal > 0 ? `${data.unreadTotal} unread` : `${data.branch.name} · ${data.items.length} threads`}
        </SectionRule>

        {data.items.length === 0 ? (
          <EmptyState
            title="No messages yet"
            body="Your coach and the front desk can reach you here, and you can reach them. Anything about billing or access gets answered fastest at reception."
          />
        ) : (
          data.items.map((conversation) => (
            <Link key={conversation.id} to="/messages/$conversationId" params={{ conversationId: conversation.id }}>
              <Panel
                tone={conversation.unread > 0 ? 'accent' : 'plain'}
                className="flex items-start gap-3 p-4"
              >
                <span className="grid h-10 w-10 flex-none place-items-center border border-line-strong font-utility text-[11px] font-semibold">
                  {conversation.counterpartInitials}
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Display size="sm" as="h3" className="truncate">
                      {conversation.counterpartName}
                    </Display>
                    <span className="flex-1" />
                    <Label>{conversation.lastMessageRelative}</Label>
                  </div>

                  <p className="mt-0.5 font-utility text-[10px] uppercase tracking-[0.12em] text-foam-35">
                    {conversation.counterpartRole.replace(/_/g, ' ')}
                    {conversation.responseWindow ? ` · replies ${conversation.responseWindow}` : ''}
                  </p>

                  <p
                    className={cx(
                      'mt-1.5 line-clamp-2 text-[13px] leading-relaxed',
                      conversation.unread > 0 ? 'text-foam' : 'text-foam-65',
                    )}
                  >
                    {conversation.lastMessageFromMe ? 'You: ' : ''}
                    {conversation.lastMessage}
                  </p>

                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {conversation.unread > 0 ? <Chip tone="accent">{conversation.unread} new</Chip> : null}
                    {conversation.muted ? <Chip tone="neutral">Muted</Chip> : null}
                    {conversation.ticket ? (
                      <Chip tone={conversation.ticket.state === 'resolved' ? 'good' : 'warn'}>
                        {conversation.ticket.reference}
                      </Chip>
                    ) : null}
                  </div>
                </div>
              </Panel>
            </Link>
          ))
        )}
      </Stack>
    </ScreenBody>
  );
}
