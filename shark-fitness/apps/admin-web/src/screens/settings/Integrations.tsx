import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { WEBHOOK_EVENT_TYPES, type WebhookDelivery, type WebhookEndpoint, type WebhookEventType } from '@shark/contracts';
import { ApiError, OfflineError, api } from '../../lib/api';
import { useBranchTimeZone } from '../../lib/store';
import {
  Button,
  Checkbox,
  Chip,
  EmptyState,
  ErrorState,
  Field,
  Label,
  Panel,
  PermissionState,
  Skeleton,
  Table,
  TableScroll,
  TD,
  TH,
  THead,
  TR,
  type Tone,
} from '../../ui/console';
import { ConfirmDialog, Modal } from '../../ui/overlay';

/* ============================================================================
   Settings → Integrations (PF-INT-003): webhooks to a gym's other systems.

   Each endpoint is an HTTPS address that receives the events it subscribes
   to, signed with a secret only the gym holds. The console shows what was
   sent and what came back, replays a delivery, and says plainly when the
   product has turned an endpoint off. Creating one, changing its address or
   showing its secret asks for a fresh password check (the API decides).
   ========================================================================= */

const GROUPS: Array<{ label: string; events: WebhookEventType[] }> = [
  { label: 'Members', events: ['member.created', 'member.updated'] },
  { label: 'Memberships and payments', events: ['membership.activated', 'membership.cancelled', 'payment.succeeded', 'payment.failed'] },
  { label: 'Attendance', events: ['attendance.checked_in', 'attendance.checked_out'] },
  { label: 'Classes', events: ['class.booked', 'class.cancelled', 'class.waitlist_promoted'] },
  { label: 'Training', events: ['workout.completed'] },
  { label: 'Leads', events: ['lead.created', 'lead.converted'] },
];

const EVENT_LABELS: Record<WebhookEventType, string> = {
  'member.created': 'Member created',
  'member.updated': 'Member details changed',
  'membership.activated': 'Membership activated',
  'membership.cancelled': 'Membership cancelled',
  'payment.succeeded': 'Payment received',
  'payment.failed': 'Payment failed',
  'attendance.checked_in': 'Checked in',
  'attendance.checked_out': 'Checked out',
  'class.booked': 'Class booked',
  'class.cancelled': 'Class booking or class cancelled',
  'class.waitlist_promoted': 'Waitlist place offered',
  'workout.completed': 'Workout completed',
  'lead.created': 'Lead created',
  'lead.converted': 'Lead became a member',
};

function messageOf(error: unknown): string {
  if (error instanceof OfflineError) return 'No connection. Check the network and try again.';
  if (error instanceof ApiError) return error.fields[0]?.message ?? error.message;
  return 'That did not work. Try again.';
}

const STATE: Record<WebhookEndpoint['state'], { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'good' },
  paused: { label: 'Paused', tone: 'neutral' },
  disabled: { label: 'Turned off', tone: 'bad' },
};

export default function Integrations({ canManage }: { canManage: boolean }) {
  const endpoints = useQuery({
    queryKey: ['integrations', 'webhooks'],
    queryFn: () => api<{ items: WebhookEndpoint[] }>('/admin/integrations/webhooks'),
    enabled: canManage,
  });
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<{ title: string; secret: string } | null>(null);

  if (!canManage) return <PermissionState what="Integrations" />;

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-start gap-3 border-b border-line p-4">
        <p className="max-w-[70ch] flex-1 text-[13px] leading-relaxed text-foam-65">
          Webhooks send events — a new member, a payment, a check-in — to another system you use, as they happen. Each
          one is signed so your system can check it came from Shark Fitness. They carry ids and states, never names,
          contact details, health information or notes.
        </p>
        <Button variant="cta" onClick={() => setCreating(true)}>
          Add endpoint
        </Button>
      </div>

      {endpoints.isPending ? (
        <div className="flex flex-col gap-2 p-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : endpoints.isError ? (
        <ErrorState title="Could not load integrations" body={messageOf(endpoints.error)} onRetry={() => void endpoints.refetch()} />
      ) : endpoints.data.items.length === 0 ? (
        <EmptyState
          title="No endpoints yet"
          body="Add an HTTPS address from your CRM, accounting or messaging tool to start receiving events."
          action={
            <Button variant="outline" onClick={() => setCreating(true)}>
              Add endpoint
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-px bg-line">
          {endpoints.data.items.map((endpoint) => (
            <EndpointCard key={endpoint.id} endpoint={endpoint} onSecret={setRevealed} />
          ))}
        </div>
      )}

      <EndpointForm
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(secret) => {
          setCreating(false);
          setRevealed({ title: 'Endpoint added', secret });
        }}
      />
      <SecretModal value={revealed} onClose={() => setRevealed(null)} />
    </div>
  );
}

function SecretModal({ value, onClose }: { value: { title: string; secret: string } | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Modal open={value !== null} onClose={onClose} title={value?.title ?? ''} kicker="Signing secret">
      <div className="flex flex-col gap-3 p-4">
        <p className="text-[13px] leading-relaxed text-foam-65">
          Give this secret to the receiving system so it can verify each delivery. Copy it now — for safety it is not
          shown again without a fresh password check.
        </p>
        <code data-testid="webhook-secret" className="break-all border border-line bg-panel px-2.5 py-2 font-utility text-[13px] font-semibold">
          {value?.secret}
        </code>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() =>
              void navigator.clipboard
                .writeText(value?.secret ?? '')
                .then(() => setCopied(true))
                .catch(() => undefined)
            }
          >
            {copied ? 'Copied' : 'Copy secret'}
          </Button>
          <Button variant="cta" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function EventPicker({ value, onChange }: { value: WebhookEventType[]; onChange: (next: WebhookEventType[]) => void }) {
  const toggle = (event: WebhookEventType, on: boolean) => onChange(on ? [...new Set([...value, event])] : value.filter((item) => item !== event));
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 font-utility text-[10px] font-semibold uppercase tracking-[0.14em] text-foam-45">Events to send</legend>
      <div className="flex gap-2">
        <Button variant="ghost" onClick={() => onChange([...WEBHOOK_EVENT_TYPES])}>
          Select all
        </Button>
        <Button variant="ghost" onClick={() => onChange([])}>
          Clear
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {GROUPS.map((group) => (
          <div key={group.label} className="flex flex-col gap-1.5">
            <Label>{group.label}</Label>
            {group.events.map((event) => (
              <Checkbox
                key={event}
                label={EVENT_LABELS[event]}
                hint={event}
                checked={value.includes(event)}
                onChange={(change) => toggle(event, change.target.checked)}
              />
            ))}
          </div>
        ))}
      </div>
    </fieldset>
  );
}

function EndpointForm({
  open,
  onClose,
  onCreated,
  endpoint,
}: {
  open: boolean;
  onClose: () => void;
  onCreated?: (secret: string) => void;
  endpoint?: WebhookEndpoint;
}) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState(endpoint?.url ?? '');
  const [description, setDescription] = useState(endpoint?.description ?? '');
  const [events, setEvents] = useState<WebhookEventType[]>(endpoint?.events ?? []);
  const save = useMutation({
    mutationFn: async () => {
      if (endpoint) {
        const patch: Record<string, unknown> = { description, events };
        if (url !== endpoint.url) patch.url = url;
        await api(`/admin/integrations/webhooks/${endpoint.id}`, { method: 'PATCH', body: patch });
        return null;
      }
      return (await api<{ secret: string }>('/admin/integrations/webhooks', { method: 'POST', body: { url, description, events } })).secret;
    },
    onSuccess: (secret) => {
      void queryClient.invalidateQueries({ queryKey: ['integrations', 'webhooks'] });
      if (secret) onCreated?.(secret);
      else onClose();
      if (!endpoint) {
        setUrl('');
        setDescription('');
        setEvents([]);
      }
    },
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={endpoint ? 'Edit endpoint' : 'Add endpoint'}
      kicker="Webhook"
      width="w-[min(640px,100%)]"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="cta" type="submit" form="webhook-endpoint-form" disabled={!url.trim() || events.length === 0} pending={save.isPending} pendingLabel="Saving…">
            {endpoint ? 'Save' : 'Add endpoint'}
          </Button>
        </>
      }
    >
      <form
        id="webhook-endpoint-form"
        className="flex flex-col gap-4 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Endpoint URL" type="url" inputMode="url" placeholder="https://" value={url} onChange={(event) => setUrl(event.target.value)} hint="HTTPS only. Private and internal network addresses are refused." />
        <Field label="Description (optional)" value={description} maxLength={200} onChange={(event) => setDescription(event.target.value)} />
        <EventPicker value={events} onChange={setEvents} />
        {save.isError ? (
          <p role="alert" className="border border-chum bg-wash-chum p-2.5 text-[13px]">
            {messageOf(save.error)}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

function EndpointCard({ endpoint, onSecret }: { endpoint: WebhookEndpoint; onSecret: (value: { title: string; secret: string }) => void }) {
  const queryClient = useQueryClient();
  const timeZone = useBranchTimeZone();
  const [showLog, setShowLog] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<'rotate' | 'delete' | null>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['integrations', 'webhooks'] });

  const test = useMutation({
    mutationFn: () => api<{ delivery: WebhookDelivery }>(`/admin/integrations/webhooks/${endpoint.id}/test`, { method: 'POST' }),
    onSuccess: () => {
      refresh();
      void queryClient.invalidateQueries({ queryKey: ['integrations', 'deliveries', endpoint.id] });
    },
  });
  const setState = useMutation({
    mutationFn: (state: 'active' | 'paused') => api(`/admin/integrations/webhooks/${endpoint.id}`, { method: 'PATCH', body: { state } }),
    onSuccess: refresh,
  });
  const rotate = useMutation({
    mutationFn: () => api<{ secret: string }>(`/admin/integrations/webhooks/${endpoint.id}/rotate-secret`, { method: 'POST' }),
    onSuccess: (result) => {
      setConfirm(null);
      refresh();
      onSecret({ title: 'New signing secret', secret: result.secret });
    },
  });
  const reveal = useMutation({
    mutationFn: () => api<{ secret: string }>(`/admin/integrations/webhooks/${endpoint.id}/secret`),
    onSuccess: (result) => onSecret({ title: 'Signing secret', secret: result.secret }),
  });
  const remove = useMutation({
    mutationFn: () => api(`/admin/integrations/webhooks/${endpoint.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setConfirm(null);
      refresh();
    },
  });
  const failure = [test, setState, reveal].find((mutation) => mutation.isError);
  const testResult = test.data?.delivery.log.at(-1);

  return (
    <Panel
      className="bg-abyss"
      title={
        <span className="flex flex-wrap items-center gap-2 normal-case tracking-normal">
          <span className="break-all font-body text-[13px] font-semibold text-foam">{endpoint.url}</span>
        </span>
      }
      action={<Chip tone={STATE[endpoint.state].tone}>{STATE[endpoint.state].label}</Chip>}
    >
      <div className="flex flex-col gap-3 p-4">
        {endpoint.description ? <p className="text-[13px] text-foam-65">{endpoint.description}</p> : null}
        {endpoint.state === 'disabled' ? (
          <p role="status" className="border border-chum bg-wash-chum p-2.5 text-[13px]">
            {endpoint.disabledReason}
          </p>
        ) : null}
        <dl className="grid gap-x-6 gap-y-1 text-[12px] sm:grid-cols-3">
          <div>
            <dt className="text-foam-45">Events</dt>
            <dd>{endpoint.events.length === WEBHOOK_EVENT_TYPES.length ? 'All events' : endpoint.events.map((event) => EVENT_LABELS[event]).join(', ')}</dd>
          </div>
          <div>
            <dt className="text-foam-45">Last delivery</dt>
            <dd>
              {endpoint.lastDelivery
                ? `${endpoint.lastDelivery.ok ? 'Delivered' : 'Failed'}${endpoint.lastDelivery.statusCode ? ` (${endpoint.lastDelivery.statusCode})` : ''} · ${new Date(endpoint.lastDelivery.at).toLocaleString('en-IN', { timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
                : 'Nothing sent yet'}
            </dd>
          </div>
          <div>
            <dt className="text-foam-45">Signing secret</dt>
            <dd>
              ••••{endpoint.secretHint}
              {endpoint.previousSecretExpiresAt ? ` · old secret also signs until ${new Date(endpoint.previousSecretExpiresAt).toLocaleString('en-IN', { timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}
            </dd>
          </div>
        </dl>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" pending={test.isPending} pendingLabel="Sending…" disabled={endpoint.state === 'disabled'} onClick={() => test.mutate()}>
            Send test event
          </Button>
          {endpoint.state === 'active' ? (
            <Button variant="outline" pending={setState.isPending} onClick={() => setState.mutate('paused')}>
              Pause
            </Button>
          ) : (
            <Button variant="outline" pending={setState.isPending} onClick={() => setState.mutate('active')}>
              {endpoint.state === 'disabled' ? 'Turn back on' : 'Resume'}
            </Button>
          )}
          <Button variant="outline" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button variant="outline" pending={reveal.isPending} onClick={() => reveal.mutate()}>
            Show secret
          </Button>
          <Button variant="outline" onClick={() => setConfirm('rotate')}>
            Rotate secret
          </Button>
          <Button variant="ghost" aria-expanded={showLog} onClick={() => setShowLog(!showLog)}>
            {showLog ? 'Hide deliveries' : 'Deliveries'}
          </Button>
          <Button variant="danger" onClick={() => setConfirm('delete')}>
            Delete
          </Button>
        </div>
        {testResult ? (
          <p role="status" className="text-[12px] text-foam-65">
            Test {testResult.ok ? 'delivered' : 'failed'}
            {testResult.statusCode ? ` with ${testResult.statusCode}` : ''} in {testResult.latencyMs} ms
            {testResult.error ? ` — ${testResult.error.replace(/\.$/, '')}` : ''}.
          </p>
        ) : null}
        {failure ? (
          <p role="alert" className="text-[12px] text-chum">
            {messageOf(failure.error)}
          </p>
        ) : null}
      </div>
      {showLog ? <DeliveryLog endpointId={endpoint.id} /> : null}

      {editing ? <EndpointForm open onClose={() => setEditing(false)} endpoint={endpoint} /> : null}
      <ConfirmDialog
        open={confirm === 'rotate'}
        onClose={() => setConfirm(null)}
        onConfirm={() => rotate.mutate()}
        title="Rotate the signing secret?"
        consequence="A new secret starts signing now. For the next 24 hours deliveries carry both signatures, so the receiving system can switch over without missing anything."
        confirmLabel="Rotate"
        tone="cta"
        pending={rotate.isPending}
        error={rotate.isError ? messageOf(rotate.error) : null}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        onClose={() => setConfirm(null)}
        onConfirm={() => remove.mutate()}
        title="Delete this endpoint?"
        consequence="Nothing more is sent to it, including deliveries still waiting to retry. The delivery history is kept."
        confirmLabel="Delete"
        pending={remove.isPending}
        error={remove.isError ? messageOf(remove.error) : null}
      />
    </Panel>
  );
}

const DELIVERY_STATE: Record<WebhookDelivery['state'], { label: string; tone: Tone }> = {
  pending: { label: 'Retrying', tone: 'warn' },
  succeeded: { label: 'Delivered', tone: 'good' },
  failed: { label: 'Gave up', tone: 'bad' },
};

function DeliveryLog({ endpointId }: { endpointId: string }) {
  const queryClient = useQueryClient();
  const timeZone = useBranchTimeZone();
  const [open, setOpen] = useState<string | null>(null);
  const deliveries = useQuery({
    queryKey: ['integrations', 'deliveries', endpointId],
    queryFn: () => api<{ items: WebhookDelivery[] }>(`/admin/integrations/webhooks/${endpointId}/deliveries`),
  });
  const replay = useMutation({
    mutationFn: (deliveryId: string) => api(`/admin/integrations/webhooks/deliveries/${deliveryId}/replay`, { method: 'POST' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['integrations', 'deliveries', endpointId] }),
  });
  const time = (iso: string) => new Date(iso).toLocaleString('en-IN', { timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });

  if (deliveries.isPending) return <Skeleton className="m-4 h-20" />;
  if (deliveries.isError) return <ErrorState title="Could not load deliveries" body={messageOf(deliveries.error)} onRetry={() => void deliveries.refetch()} />;
  if (deliveries.data.items.length === 0) return <EmptyState title="No deliveries yet" body="Events appear here within a minute of happening. Send a test event to check the connection." />;
  return (
    <div className="border-t border-line">
      <TableScroll>
        <Table label="Recent deliveries">
          <THead>
            <TH>Event</TH>
            <TH>Created</TH>
            <TH>Status</TH>
            <TH>Attempts</TH>
            <TH>Last answer</TH>
            <TH>
              <span className="sr-only">Actions</span>
            </TH>
          </THead>
          <tbody>
            {deliveries.data.items.map((delivery) => (
              <DeliveryRow
                key={delivery.id}
                delivery={delivery}
                time={time}
                expanded={open === delivery.id}
                onToggle={() => setOpen(open === delivery.id ? null : delivery.id)}
                onReplay={() => replay.mutate(delivery.id)}
                replaying={replay.isPending && replay.variables === delivery.id}
              />
            ))}
          </tbody>
        </Table>
      </TableScroll>
      {replay.isError ? (
        <p role="alert" className="p-3 text-[12px] text-chum">
          {messageOf(replay.error)}
        </p>
      ) : null}
    </div>
  );
}

function DeliveryRow({
  delivery,
  time,
  expanded,
  onToggle,
  onReplay,
  replaying,
}: {
  delivery: WebhookDelivery;
  time: (iso: string) => string;
  expanded: boolean;
  onToggle: () => void;
  onReplay: () => void;
  replaying: boolean;
}) {
  return (
    <>
      <TR>
        <TD>
          {delivery.test ? 'Test event' : EVENT_LABELS[delivery.eventType as WebhookEventType] ?? delivery.eventType}
          {delivery.replayOf ? <span className="ml-1 text-foam-45">(replay)</span> : null}
        </TD>
        <TD>{time(delivery.createdAt)}</TD>
        <TD>
          <Chip tone={DELIVERY_STATE[delivery.state].tone}>
            {delivery.test && delivery.state === 'failed' ? 'Failed' : DELIVERY_STATE[delivery.state].label}
          </Chip>
        </TD>
        <TD>{delivery.attempts}</TD>
        <TD>{delivery.lastStatusCode ?? delivery.lastError ?? '—'}</TD>
        <TD>
          <span className="flex gap-1">
            <Button variant="ghost" aria-expanded={expanded} onClick={onToggle}>
              {expanded ? 'Hide log' : 'Log'}
            </Button>
            <Button variant="ghost" pending={replaying} onClick={onReplay}>
              Replay
            </Button>
          </span>
        </TD>
      </TR>
      {expanded ? (
        <tr>
          <td colSpan={6} className="border-b border-line-10 bg-panel px-3.5 py-2">
            <ol className="flex flex-col gap-1 text-[12px]" aria-label="Attempts">
              {delivery.log.map((attempt) => (
                <li key={attempt.attempt}>
                  #{attempt.attempt} · {time(attempt.at)} · {attempt.statusCode ?? 'no answer'} · {attempt.latencyMs} ms
                  {attempt.error ? ` · ${attempt.error}` : ''}
                  {attempt.responseExcerpt ? <span className="block truncate text-foam-45">{attempt.responseExcerpt}</span> : null}
                </li>
              ))}
              {delivery.nextAttemptAt ? <li className="text-foam-45">Next try {time(delivery.nextAttemptAt)}</li> : null}
            </ol>
          </td>
        </tr>
      ) : null}
    </>
  );
}
