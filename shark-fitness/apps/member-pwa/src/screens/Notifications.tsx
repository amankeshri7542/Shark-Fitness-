import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ApiError, api } from '../lib/api';
import { ScreenBody, Stack } from '../ui/shell';
import {
  Button,
  Chip,
  Display,
  EmptyState,
  ErrorState,
  Label,
  Panel,
  SectionRule,
  Skeleton,
  type Tone,
} from '../ui/primitives';

/**
 * Notifications.
 *
 * Served from `/me/notifications`, not `/member/*` — this is account-level, so
 * it follows the account namespace.
 *
 * Everything here is plain register. A cancelled class, a failed payment and a
 * waitlist offer are all moments where a member needs to know exactly what
 * happened and what to do; the predator voice belongs on the training floor.
 */

interface Notification {
  id: string;
  channel: string;
  title: string;
  body: string;
  createdAt: string;
  relativeTime: string;
  readAt: string | null;
  link: string | null;
  kind: string;
}

interface Payload {
  items: Notification[];
  unread: number;
}

/** Tone carries meaning, so it is derived from the kind rather than decorative. */
const KIND_TONE: Record<string, Tone> = {
  waitlist_offer: 'warn',
  session_cancelled: 'bad',
  session_changed: 'warn',
  payment_failed: 'bad',
  payment_succeeded: 'good',
  invoice_due: 'warn',
  membership_expiring: 'warn',
};

const KIND_LABEL: Record<string, string> = {
  waitlist_offer: 'Seat offered',
  session_cancelled: 'Class cancelled',
  session_changed: 'Class changed',
  payment_failed: 'Payment',
  payment_succeeded: 'Payment',
  invoice_due: 'Billing',
  membership_expiring: 'Membership',
};

export default function NotificationsScreen() {
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<Payload>('/me/notifications'),
  });

  const markRead = useMutation({
    mutationFn: (ids?: string[]) =>
      api<{ marked: number }>('/me/notifications/read', { method: 'POST', body: ids ? { ids } : {} }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
      void queryClient.invalidateQueries({ queryKey: ['home'] });
    },
  });

  if (isLoading) {
    return (
      <ScreenBody>
        <Stack>
          <Skeleton className="h-8" />
          {Array.from({ length: 5 }, (_, i) => (
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
            title="Could not load notifications"
            body="Nothing has been missed — they are still on the server. Try again in a moment."
            onRetry={() => void refetch()}
            requestId={error instanceof ApiError ? error.requestId : undefined}
          />
        </Stack>
      </ScreenBody>
    );
  }

  if (data.items.length === 0) {
    return (
      <ScreenBody>
        <Stack>
          <EmptyState
            title="Nothing to read"
            body="Class changes, waitlist offers and anything to do with your membership will show up here."
          />
        </Stack>
      </ScreenBody>
    );
  }

  return (
    <ScreenBody>
      <Stack>
        <SectionRule
          action={
            data.unread > 0 ? (
              <Button variant="ghost" size="sm" disabled={markRead.isPending} onClick={() => markRead.mutate(undefined)}>
                Mark all read
              </Button>
            ) : null
          }
        >
          {data.unread > 0 ? `${data.unread} unread` : 'All read'}
        </SectionRule>

        {data.items.map((item) => {
          const unread = item.readAt === null;
          const body = (
            <Panel
              tone={unread ? 'accent' : 'plain'}
              className="flex flex-col gap-2 p-4"
              key={item.id}
              onClick={unread ? () => markRead.mutate([item.id]) : undefined}
            >
              <div className="flex items-center gap-2">
                <Chip tone={KIND_TONE[item.kind] ?? 'neutral'}>{KIND_LABEL[item.kind] ?? 'Update'}</Chip>
                <span className="flex-1" />
                <Label>{item.relativeTime}</Label>
              </div>
              <Display size="sm" as="h3">
                {item.title}
              </Display>
              <p className="text-[13px] leading-relaxed text-foam-65">{item.body}</p>
            </Panel>
          );

          // A notification that points somewhere is a link; one that does not
          // must not pretend to be tappable.
          return item.link ? (
            <Link key={item.id} to={item.link} onClick={() => unread && markRead.mutate([item.id])}>
              {body}
            </Link>
          ) : (
            body
          );
        })}
      </Stack>
    </ScreenBody>
  );
}
