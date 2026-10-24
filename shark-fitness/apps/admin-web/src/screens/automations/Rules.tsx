import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, idempotencyKey } from '../../lib/api';
import {
  Button,
  Chip,
  EmptyState,
  ErrorState,
  Field,
  Label,
  SelectField,
  Skeleton,
  Table,
  TableScroll,
  TD,
  TH,
  THead,
  TR,
  Toolbar,
  type Tone,
} from '../../ui/console';
import { Modal } from '../../ui/overlay';
import Preview from './Preview';

/* ============================================================================
   The rules.

   A table of what is running, what is rehearsing and what is paused — because
   the question an operator opens this screen with is "is anything messaging my
   members right now", and a wall of cards answers it worse than three columns.

   The distinction the table leads with is not on/off. It is **live or
   rehearsing**: an automation can be active and still in dry run, and an
   operator who reads "active" as "sending" will be wrong about the one thing
   that matters here.
   ========================================================================= */

export interface AutomationRow {
  id: string;
  name: string;
  description: string;
  trigger: string;
  triggerLabel: string;
  state: 'draft' | 'active' | 'paused';
  dryRun: boolean;
  channel: string;
  templateCode: string | null;
  conditions: Array<{ field: string; op: string; value: string }>;
  quietHours: { from: string; to: string } | null;
  runsLast30: number;
  lastRunAt: string | null;
}

export interface TriggerSpec {
  key: string;
  label: string;
  description: string;
  variables: string[];
  fields: string[];
  window: string;
}

interface Payload {
  items: AutomationRow[];
  triggers: TriggerSpec[];
}

const CHANNELS = [
  { value: 'in_app', label: 'In-app' },
  { value: 'push', label: 'Push' },
  { value: 'email', label: 'Email' },
  { value: 'sms', label: 'SMS — metered' },
  { value: 'whatsapp', label: 'WhatsApp — metered' },
];

/** Live is the only state that reaches a member. Everything else rehearses. */
function standing(row: AutomationRow): { label: string; tone: Tone } {
  if (row.state === 'paused') return { label: 'Paused', tone: 'neutral' };
  if (row.state === 'draft') return { label: 'Draft', tone: 'neutral' };
  if (row.dryRun) return { label: 'Rehearsing', tone: 'warn' };
  return { label: 'Live', tone: 'good' };
}

export default function Rules() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const automations = useQuery({
    queryKey: ['automations'],
    queryFn: () => api<Payload>('/admin/automations'),
  });

  if (automations.isLoading) return <Skeleton className="h-96" />;
  if (automations.error || !automations.data) {
    return (
      <ErrorState
        title="Your automations could not be read"
        body={automations.error instanceof ApiError ? automations.error.message : 'The server did not answer.'}
        onRetry={() => void automations.refetch()}
      />
    );
  }

  const { items, triggers } = automations.data;
  const live = items.filter((a) => a.state === 'active' && !a.dryRun).length;

  return (
    <>
      <Toolbar>
        <Label>Rules</Label>
        <span className="font-utility text-[11px] uppercase tracking-[0.12em] text-foam-45">{items.length} total</span>
        <Chip tone={live > 0 ? 'good' : 'neutral'}>
          {live === 0 ? 'None sending' : `${live} sending`}
        </Chip>
        <span className="flex-1" />
        <Button variant="cta" onClick={() => setCreating(true)}>
          New rule
        </Button>
      </Toolbar>

      {items.length === 0 ? (
        <EmptyState
          title="No automations yet"
          body="A rule watches for something happening and sends one message when it does. Every new rule starts rehearsing, so you can see who it reaches before anybody hears from it."
          action={
            <Button variant="cta" onClick={() => setCreating(true)}>
              New rule
            </Button>
          }
        />
      ) : (
        <TableScroll>
          <Table label="Automation rules">
            <THead>
              <TH>Rule</TH>
              <TH>When</TH>
              <TH>Standing</TH>
              <TH>Channel</TH>
              <TH numeric>Sent 30d</TH>
              <TH>Last run</TH>
            </THead>
            <tbody>
              {items.map((row) => {
                const badge = standing(row);
                return (
                  <TR key={row.id} onClick={() => setOpenId(row.id)}>
                    <TD>
                      <span className="block truncate text-foam">{row.name}</span>
                      {row.description ? (
                        <span className="block truncate text-[11px] text-foam-45">{row.description}</span>
                      ) : null}
                    </TD>
                    <TD>{row.triggerLabel}</TD>
                    <TD>
                      <Chip tone={badge.tone}>{badge.label}</Chip>
                    </TD>
                    <TD className="capitalize">{row.channel.replace(/_/g, '-')}</TD>
                    <TD numeric>{row.runsLast30}</TD>
                    <TD>
                      {row.lastRunAt
                        ? new Date(row.lastRunAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
                        : '—'}
                    </TD>
                  </TR>
                );
              })}
            </tbody>
          </Table>
        </TableScroll>
      )}

      {creating ? (
        <RuleDialog
          triggers={triggers}
          onClose={() => setCreating(false)}
          onSaved={() => {
            void queryClient.invalidateQueries({ queryKey: ['automations'] });
            setCreating(false);
          }}
        />
      ) : null}

      {openId ? (
        <RuleDialog
          triggers={triggers}
          existing={items.find((a) => a.id === openId)}
          onClose={() => setOpenId(null)}
          onSaved={() => void queryClient.invalidateQueries({ queryKey: ['automations'] })}
        />
      ) : null}
    </>
  );
}

/* ——— The rule builder ————————————————————————————————— */

function RuleDialog({
  triggers,
  existing,
  onClose,
  onSaved,
}: {
  triggers: TriggerSpec[];
  existing?: AutomationRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [trigger, setTrigger] = useState(existing?.trigger ?? triggers[0]?.key ?? '');
  const [channel, setChannel] = useState(existing?.channel ?? 'in_app');
  const [templateCode, setTemplateCode] = useState(existing?.templateCode ?? '');
  const [conditions, setConditions] = useState(existing?.conditions ?? []);

  const templates = useQuery({
    queryKey: ['automations', 'templates'],
    queryFn: () => api<{ items: Array<{ code: string; channel: string; variables: string[] }> }>('/admin/automations/templates'),
  });

  const spec = triggers.find((t) => t.key === trigger);
  const attempt = idempotencyKey('automation', name.trim(), trigger);

  const body = {
    name: name.trim(),
    description: description.trim(),
    trigger,
    channel,
    templateCode: templateCode || null,
    conditions,
  };

  const save = useMutation({
    mutationFn: () =>
      existing
        ? api(`/admin/automations/${existing.id}`, { method: 'PATCH', body })
        : api('/admin/automations', { method: 'POST', body, idempotencyKey: attempt }),
    onSuccess: () => {
      onSaved();
      if (!existing) onClose();
    },
  });

  const setStanding = useMutation({
    mutationFn: (patch: { state?: string; dryRun?: boolean }) =>
      api(`/admin/automations/${existing!.id}`, { method: 'PATCH', body: patch }),
    onSuccess: () => {
      onSaved();
      void queryClient.invalidateQueries({ queryKey: ['automations'] });
    },
  });

  const badge = existing ? standing(existing) : null;

  return (
    <Modal
      open
      onClose={onClose}
      title={existing ? existing.name : 'New rule'}
      kicker={existing ? badge!.label : 'It starts rehearsing'}
      width="w-[min(760px,100%)]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="cta"
            disabled={!name.trim() || !trigger || save.isPending}
            pending={save.isPending}
            pendingLabel="Saving…"
            onClick={() => save.mutate()}
          >
            {existing ? 'Save rule' : 'Create rule'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col">
        <div className="flex flex-col gap-3 border-b border-line p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Name" placeholder="Renewal nudge" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
            <Field label="What it is for" placeholder="Texts members a week before their plan ends." value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>

          <SelectField
            label="When this happens"
            hint={spec?.description}
            value={trigger}
            onChange={(e) => {
              setTrigger(e.target.value);
              // Conditions belong to the trigger they were written against.
              setConditions([]);
            }}
            options={triggers.map((t) => ({ value: t.key, label: t.label }))}
          />

          <Conditions spec={spec} conditions={conditions} onChange={setConditions} />

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <SelectField
              label="Send by"
              hint={channel === 'sms' || channel === 'whatsapp' ? 'Metered — you will see the cost before it sends.' : 'Costs nothing per message.'}
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              options={CHANNELS}
            />
            <SelectField
              label="Using this message"
              hint={spec ? `It may use ${spec.variables.join(', ')}.` : undefined}
              value={templateCode}
              onChange={(e) => setTemplateCode(e.target.value)}
              options={[
                { value: '', label: 'Choose a message' },
                ...(templates.data?.items ?? []).map((t) => ({ value: t.code, label: `${t.code} · ${t.channel}` })),
              ]}
            />
          </div>

          {save.isError ? (
            <p role="alert" className="border border-chum bg-wash-chum px-3 py-2 text-[12px] leading-relaxed text-foam-80">
              {save.error instanceof ApiError ? save.error.message : 'That rule could not be saved.'}
            </p>
          ) : null}
        </div>

        {existing ? (
          <>
            <Standing automation={existing} onChange={(patch) => setStanding.mutate(patch)} pending={setStanding.isPending} error={setStanding.error} />
            <Preview automationId={existing.id} />
          </>
        ) : (
          <p className="p-4 text-[12px] leading-relaxed text-foam-45">
            Save it, then look at exactly who it reaches before letting it send.
          </p>
        )}
      </div>
    </Modal>
  );
}

/* ——— Conditions ————————————————————————————————————————— */

const OPS = [
  { value: 'eq', label: 'is' },
  { value: 'neq', label: 'is not' },
  { value: 'lt', label: 'is less than' },
  { value: 'lte', label: 'is at most' },
  { value: 'gt', label: 'is more than' },
  { value: 'gte', label: 'is at least' },
  { value: 'contains', label: 'contains' },
];

function Conditions({
  spec,
  conditions,
  onChange,
}: {
  spec: TriggerSpec | undefined;
  conditions: Array<{ field: string; op: string; value: string }>;
  onChange: (next: Array<{ field: string; op: string; value: string }>) => void;
}) {
  if (!spec) return null;

  return (
    <div className="flex flex-col gap-2">
      <Label>Only when</Label>
      {conditions.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-foam-45">
          No conditions — this reaches everyone the trigger applies to.
        </p>
      ) : null}

      {conditions.map((condition, index) => (
        <div key={index} className="flex flex-wrap items-end gap-2">
          <SelectField
            label="Field"
            className="!w-auto"
            value={condition.field}
            onChange={(e) => onChange(conditions.map((c, i) => (i === index ? { ...c, field: e.target.value } : c)))}
            options={spec.fields.map((f) => ({ value: f, label: f }))}
          />
          <SelectField
            label="Test"
            className="!w-auto"
            value={condition.op}
            onChange={(e) => onChange(conditions.map((c, i) => (i === index ? { ...c, op: e.target.value } : c)))}
            options={OPS}
          />
          <Field
            label="Value"
            className="!w-auto"
            value={condition.value}
            onChange={(e) => onChange(conditions.map((c, i) => (i === index ? { ...c, value: e.target.value } : c)))}
          />
          <Button variant="ghost" onClick={() => onChange(conditions.filter((_c, i) => i !== index))}>
            Remove
          </Button>
        </div>
      ))}

      <div>
        <Button
          variant="outline"
          onClick={() => onChange([...conditions, { field: spec.fields[0] ?? '', op: 'eq', value: '' }])}
        >
          Add a condition
        </Button>
      </div>
      {conditions.length > 1 ? (
        <p className="text-[11px] leading-relaxed text-foam-45">All of these must be true.</p>
      ) : null}
    </div>
  );
}

/* ——— Live or rehearsing ————————————————————————————————— */

function Standing({
  automation,
  onChange,
  pending,
  error,
}: {
  automation: AutomationRow;
  onChange: (patch: { state?: string; dryRun?: boolean }) => void;
  pending: boolean;
  error: unknown;
}) {
  const badge = standing(automation);
  return (
    <section aria-label="Standing" className="border-b border-line">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 bg-hull px-4 py-3">
        <Chip tone={badge.tone}>{badge.label}</Chip>
        <p className="min-w-[24ch] flex-1 text-[12px] leading-relaxed text-foam-65">
          {automation.dryRun
            ? 'Rehearsing. It records what it would have done and nobody hears from it.'
            : automation.state === 'active'
              ? 'Live. This reaches members.'
              : 'Not running.'}
        </p>
        {automation.state !== 'active' ? (
          <Button variant="outline" disabled={pending} onClick={() => onChange({ state: 'active' })}>
            Start it
          </Button>
        ) : (
          <Button variant="outline" disabled={pending} onClick={() => onChange({ state: 'paused' })}>
            Pause it
          </Button>
        )}
        {automation.dryRun ? (
          <Button variant="cta" disabled={pending} pending={pending} pendingLabel="…" onClick={() => onChange({ dryRun: false })}>
            Let it send
          </Button>
        ) : (
          <Button variant="danger" disabled={pending} onClick={() => onChange({ dryRun: true })}>
            Back to rehearsing
          </Button>
        )}
      </div>
      {error instanceof ApiError ? (
        <p role="alert" className="border-t border-line bg-wash-chum px-4 py-2.5 text-[12px] leading-relaxed text-foam-80">
          {error.message}
        </p>
      ) : null}
    </section>
  );
}
