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
  Panel,
  SelectField,
  Skeleton,
  TextAreaField,
  Toolbar,
} from '../../ui/console';

/* ============================================================================
   The messages themselves (PF-COMM-003).

   An editor with the variable list beside it, because the failure this screen
   exists to prevent is a template asking for something the trigger does not
   have — which the engine then refuses at send time, quietly, for every member,
   until somebody looks at the run log.

   Saving writes a new version rather than editing the old one. A message
   already sent was sent under the words that existed then, and rewriting the
   row makes the delivery log describe something that never happened.
   ========================================================================= */

interface TemplateRow {
  id: string;
  code: string;
  channel: string;
  version: number;
  subject: string | null;
  body: string;
  variables: string[];
}

const CHANNELS = [
  { value: 'in_app', label: 'In-app' },
  { value: 'push', label: 'Push' },
  { value: 'email', label: 'Email' },
  { value: 'sms', label: 'SMS' },
  { value: 'whatsapp', label: 'WhatsApp' },
];

export default function Templates() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<TemplateRow | null>(null);
  const [creating, setCreating] = useState(false);

  const templates = useQuery({
    queryKey: ['automations', 'templates'],
    queryFn: () => api<{ items: TemplateRow[] }>('/admin/automations/templates'),
  });

  const triggers = useQuery({
    queryKey: ['automations'],
    queryFn: () => api<{ triggers: Array<{ key: string; label: string; variables: string[] }> }>('/admin/automations'),
  });

  if (templates.isLoading) return <Skeleton className="h-64" />;
  if (templates.error || !templates.data) {
    return (
      <ErrorState
        title="Your messages could not be read"
        body={templates.error instanceof ApiError ? templates.error.message : 'The server did not answer.'}
        onRetry={() => void templates.refetch()}
      />
    );
  }

  const latest = new Map<string, TemplateRow>();
  for (const row of templates.data.items) {
    const held = latest.get(row.code);
    if (!held || row.version > held.version) latest.set(row.code, row);
  }
  const items = [...latest.values()].sort((a, b) => a.code.localeCompare(b.code));
  const open = editing ?? (creating ? { id: '', code: '', channel: 'in_app', version: 0, subject: null, body: '' , variables: [] } : null);

  return (
    <>
      <Toolbar>
        <Label>Messages</Label>
        <span className="font-utility text-[11px] uppercase tracking-[0.12em] text-foam-45">{items.length} in use</span>
        <span className="flex-1" />
        <Button variant="cta" onClick={() => { setEditing(null); setCreating(true); }}>
          New message
        </Button>
      </Toolbar>

      {items.length === 0 ? (
        <EmptyState title="No messages yet" body="A rule needs something to say. Write one, and the variables it may use are listed as you type." />
      ) : (
        <div className="grid grid-cols-1 gap-px bg-line xl:grid-cols-2">
          {items.map((template) => (
            <Panel
              key={template.code}
              title={template.code}
              action={
                <span className="flex items-center gap-2">
                  <Chip tone="neutral">{template.channel.replace(/_/g, '-')}</Chip>
                  <Chip tone="neutral">v{template.version}</Chip>
                  <Button variant="ghost" onClick={() => { setCreating(false); setEditing(template); }}>
                    Edit
                  </Button>
                </span>
              }
            >
              <div className="flex flex-col gap-2 px-3.5 py-3">
                {template.subject ? (
                  <p className="text-[12px] font-semibold text-foam-80">{template.subject}</p>
                ) : null}
                <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-foam-65">{template.body}</p>
                {template.variables.length > 0 ? (
                  <p className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
                    uses {template.variables.join(', ')}
                  </p>
                ) : null}
              </div>
            </Panel>
          ))}
        </div>
      )}

      {open ? (
        <Editor
          template={open}
          triggers={triggers.data?.triggers ?? []}
          onClose={() => { setEditing(null); setCreating(false); }}
          onSaved={() => {
            void queryClient.invalidateQueries({ queryKey: ['automations', 'templates'] });
            setEditing(null);
            setCreating(false);
          }}
        />
      ) : null}
    </>
  );
}

function Editor({
  template,
  triggers,
  onClose,
  onSaved,
}: {
  template: TemplateRow;
  triggers: Array<{ key: string; label: string; variables: string[] }>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = template.version === 0;
  const [code, setCode] = useState(template.code);
  const [channel, setChannel] = useState(template.channel);
  const [subject, setSubject] = useState(template.subject ?? '');
  const [body, setBody] = useState(template.body);

  const save = useMutation({
    mutationFn: () =>
      api('/admin/automations/templates', {
        method: 'POST',
        body: { code: code.trim(), channel, subject: subject.trim() || null, body: body.trim() },
        idempotencyKey: idempotencyKey('automation-template', code.trim(), String(template.version + 1), body.trim()),
      }),
    onSuccess: onSaved,
  });

  const used = [...body.matchAll(/\{\{\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*\}\}/g)].map((m) => m[1]!);
  const unique = [...new Set(used)];

  return (
    <Panel
      title={isNew ? 'New message' : `${template.code} · new version`}
      className="border-t border-line"
      action={
        <span className="flex items-center gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="cta"
            disabled={!code.trim() || !body.trim() || save.isPending}
            pending={save.isPending}
            pendingLabel="Saving…"
            onClick={() => save.mutate()}
          >
            {isNew ? 'Create message' : 'Save as new version'}
          </Button>
        </span>
      }
    >
      <div className="grid grid-cols-1 gap-px bg-line xl:grid-cols-[1fr_280px]">
        <div className="flex flex-col gap-3 bg-panel p-3.5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label="Code"
              hint="How a rule refers to it. Lowercase, dots and dashes."
              value={code}
              disabled={!isNew}
              onChange={(e) => setCode(e.target.value.toLowerCase())}
            />
            <SelectField label="Channel" value={channel} onChange={(e) => setChannel(e.target.value)} options={CHANNELS} />
          </div>

          {channel === 'email' || channel === 'in_app' ? (
            <Field label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
          ) : null}

          <TextAreaField
            label="Message"
            rows={6}
            hint="Wrap a variable in double braces, like {{firstName}}."
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />

          {unique.length > 0 ? (
            <p className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-45">
              This uses {unique.join(', ')}
            </p>
          ) : null}

          {!isNew ? (
            <p className="text-[11px] leading-relaxed text-foam-45">
              Saving creates version {template.version + 1}. Existing rules stay pinned to their reviewed version until you edit and re-preview them.
            </p>
          ) : null}

          {save.isError ? (
            <p role="alert" className="border border-chum bg-wash-chum px-3 py-2 text-[12px] leading-relaxed text-foam-80">
              {save.error instanceof ApiError ? save.error.message : 'That message could not be saved.'}
            </p>
          ) : null}
        </div>

        {/* The variable reference sits beside the field rather than behind a
            help link: the failure this screen prevents is asking for something
            the trigger does not have, and you cannot avoid that from memory. */}
        <div className="bg-panel p-3.5">
          <Label>What you can use</Label>
          <ul className="mt-2 flex flex-col gap-2.5">
            {triggers.map((trigger) => (
              <li key={trigger.key}>
                <div className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-45">{trigger.label}</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {trigger.variables.map((variable) => (
                    <button
                      key={variable}
                      type="button"
                      onClick={() => setBody((current) => `${current}{{${variable}}}`)}
                      className="cursor-pointer border border-line px-1.5 py-0.5 font-utility text-[10px] text-foam-65 hover:border-sonar hover:text-sonar"
                    >
                      {variable}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Panel>
  );
}
