import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ApiError, OfflineError, api } from '../lib/api';
import { ScreenBody, Stack } from '../ui/shell';
import { Button, Display, ErrorState, Label, Panel, SectionRule, Skeleton, cx } from '../ui/primitives';

/**
 * Start a conversation (PF-COMM-001, UX-M12).
 *
 * Two people a member can write to: their coach and their branch's front
 * desk. Before a word is typed the screen says when that person replies, and
 * outside their hours it says when the message will be read — a member
 * writing at 23:40 should know the desk opens at 6am, not find out by being
 * ignored. Plain register throughout: this is a support surface.
 */

interface Counterpart {
  available: boolean;
  name: string;
  initials?: string;
  responseWindow: string;
  outsideHours: boolean;
  outsideNote: string | null;
}

export interface StartOptions {
  topics: Array<{ key: string; label: string }>;
  blocked: boolean;
  blockedReason: string | null;
  coach: Counterpart | null;
  coachMissingNote: string | null;
  desk: Counterpart;
}

interface InboxPayload {
  start: StartOptions;
}

type To = 'coach' | 'desk';

export default function NewMessageScreen() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['messages'],
    queryFn: () => api<InboxPayload & Record<string, unknown>>('/member/messages'),
  });
  const [to, setTo] = useState<To | null>(null);
  const [topic, setTopic] = useState('');
  const [body, setBody] = useState('');
  const [clientId] = useState(() => `start-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

  const send = useMutation({
    mutationFn: () =>
      api<{ conversationId: string }>('/member/messages/start', {
        method: 'POST',
        body: { to, topic, body: body.trim(), clientId },
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['messages'] });
      void navigate({ to: '/messages/$conversationId', params: { conversationId: result.conversationId } });
    },
  });

  if (isLoading) {
    return (
      <ScreenBody>
        <Stack>
          <Skeleton className="h-10" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </Stack>
      </ScreenBody>
    );
  }

  if (error || !data?.start) {
    return (
      <ScreenBody>
        <Stack>
          <ErrorState
            title="Could not open a new message"
            body={error instanceof OfflineError ? 'You are offline. Starting a conversation needs a connection.' : 'Try again in a moment.'}
            onRetry={() => void refetch()}
            requestId={error instanceof ApiError ? error.requestId : undefined}
          />
        </Stack>
      </ScreenBody>
    );
  }

  const start = data.start;

  if (start.blocked) {
    return (
      <ScreenBody>
        <Stack>
          <Display size="md">New message</Display>
          <Panel tone="warn" className="flex flex-col gap-2 p-4">
            <Label>Messages are not available</Label>
            <p className="text-[13px] leading-relaxed text-foam-65">{start.blockedReason}</p>
          </Panel>
          <Link to="/messages" className="self-start">
            <span className="font-utility text-[11px] font-semibold uppercase tracking-[0.12em] text-sonar">Back to messages</span>
          </Link>
        </Stack>
      </ScreenBody>
    );
  }

  const chosen = to === 'coach' ? start.coach : to === 'desk' ? start.desk : null;
  const canSend = Boolean(to && topic && body.trim().length > 0 && !send.isPending);
  const sendError =
    send.error instanceof OfflineError
      ? 'You are offline. Your message is still here — send it when you have signal.'
      : send.error instanceof ApiError
        ? send.error.message
        : send.error
          ? 'That did not send. Your message is still here; try again.'
          : null;

  return (
    <ScreenBody>
      <form
        className="flex flex-col gap-4 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSend) send.mutate();
        }}
      >
        <Display size="md">New message</Display>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 font-utility text-[10px] font-semibold uppercase tracking-[0.14em] text-foam-50">Who to</legend>
          <ChoiceCard
            name="to"
            value="coach"
            checked={to === 'coach'}
            disabled={!start.coach}
            onSelect={() => setTo('coach')}
            title={start.coach ? start.coach.name : 'Your coach'}
            subtitle={start.coach ? `Coach · ${start.coach.responseWindow}` : (start.coachMissingNote ?? 'No coach assigned')}
          />
          <ChoiceCard
            name="to"
            value="desk"
            checked={to === 'desk'}
            onSelect={() => setTo('desk')}
            title={start.desk.name}
            subtitle={start.desk.responseWindow}
          />
        </fieldset>

        {chosen?.outsideHours && chosen.outsideNote ? (
          <Panel tone="warn" className="p-4" role="status">
            <p className="text-[13px] leading-relaxed text-foam-65">{chosen.outsideNote}</p>
          </Panel>
        ) : null}

        <label className="flex flex-col gap-1.5">
          <span className="font-utility text-[10px] font-semibold uppercase tracking-[0.14em] text-foam-50">About</span>
          <select className="sf-field" value={topic} onChange={(e) => setTopic(e.target.value)} required>
            <option value="">Choose a topic</option>
            {start.topics.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="font-utility text-[10px] font-semibold uppercase tracking-[0.14em] text-foam-50">Message</span>
          <textarea
            className="sf-field min-h-32 resize-y"
            value={body}
            maxLength={4000}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Write your message"
          />
        </label>
        <p className="text-[12px] leading-relaxed text-foam-50">
          You can add a photo or PDF once the conversation is open. If something is urgent or you are hurt, tell the
          team in person.
        </p>

        {sendError ? (
          <p role="alert" className="text-[13px] text-chum">
            {sendError}
          </p>
        ) : null}

        <SectionRule>{chosen ? chosen.responseWindow : 'Choose who to write to'}</SectionRule>
        <Button type="submit" variant="cta" size="lg" full disabled={!canSend}>
          {send.isPending ? 'Sending…' : 'Send'}
        </Button>
      </form>
    </ScreenBody>
  );
}

function ChoiceCard({ name, value, checked, disabled, onSelect, title, subtitle }: {
  name: string;
  value: string;
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
  title: string;
  subtitle: string;
}) {
  return (
    <label
      className={cx(
        'flex min-h-14 cursor-pointer items-center gap-3 border p-3.5',
        checked ? 'border-sonar bg-wash-sonar' : 'border-line-strong',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <input type="radio" name={name} value={value} checked={checked} disabled={disabled} onChange={onSelect} className="h-5 w-5 accent-[var(--sf-sonar)]" />
      <span className="min-w-0">
        <span className="block text-[14px] text-foam">{title}</span>
        <span className="block text-[12px] text-foam-50">{subtitle}</span>
      </span>
    </label>
  );
}
