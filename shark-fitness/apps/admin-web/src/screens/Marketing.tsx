import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatMoney } from '@shark/domain';
import { ApiError, OfflineError, api, idempotencyKey } from '../lib/api';
import { useAdmin, useBranchScope, usePermission } from '../lib/store';
import { useOnline } from '../lib/realtime';
import { Page } from '../ui/shell';
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
  SelectField,
  Skeleton,
  TextAreaField,
  type Tone,
} from '../ui/console';
import { Drawer, Modal } from '../ui/overlay';
import { ChannelStrip, channelState, type ChannelAvailability } from '../ui/channels';

/* ============================================================================
   Marketing — one-off broadcasts (P07; PF-COMM-006).

   Compose, see exactly who it reaches and what it costs, rehearse, then send.
   The preview runs every check the send runs (consent, opt-out, a missing
   number or address, a channel this server cannot use, quiet hours), so the
   number an operator approves is the number that goes. Above the gym's
   threshold an owner approves first, with a fresh sign-in check.
   ========================================================================= */

type Channel = ChannelAvailability['channel'];

export interface ChannelPreview {
  channel: Channel;
  label: string;
  recipients: number;
  heldForQuietHours: number;
  excluded: Record<string, number>;
  ratePerMessageMinor: number;
  estimatedCostMinor: number;
}

export interface Preview {
  segmentSize: number;
  chosen: ChannelPreview;
  byChannel: ChannelPreview[];
  approvalThreshold: number;
  approvalRequired: boolean;
}

export interface BroadcastRow {
  id: string;
  name: string;
  channel: Channel;
  purpose: 'promotional' | 'operational';
  title: string;
  body: string;
  state: 'draft' | 'awaiting_approval' | 'approved' | 'sent' | 'cancelled';
  recipientCount: number;
  estimatedCostMinor: number;
  approvalRequired: boolean;
  approved: boolean;
  lastDryRunAt: string | null;
  sentAt: string | null;
  createdRelative: string;
}

interface ListPayload {
  items: BroadcastRow[];
  approvalThreshold: number;
  channels: ChannelAvailability[];
}

const EXCLUSION_LABEL: Record<string, string> = {
  no_consent: 'have not agreed to this channel',
  opted_out: 'switched these messages off',
  no_destination: 'have no number or address on file',
  channel_unavailable: 'cannot be reached: channel not set up here',
  inactive: 'have no active account',
  missing_variable: 'are missing a value the message needs',
};

const STATE: Record<BroadcastRow['state'], { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  awaiting_approval: { label: 'Waiting for owner', tone: 'warn' },
  approved: { label: 'Approved', tone: 'accent' },
  sent: { label: 'Sent', tone: 'good' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

const STATUSES = [
  { value: 'active', label: 'Active' },
  { value: 'trial', label: 'Trial' },
  { value: 'frozen', label: 'Frozen' },
  { value: 'grace', label: 'In grace' },
  { value: 'expired', label: 'Expired' },
  { value: 'former', label: 'Former' },
];

function failure(error: unknown, fallback: string): string {
  if (error instanceof OfflineError) return 'No connection. Nothing was sent.';
  if (error instanceof ApiError) return error.message;
  return fallback;
}

export default function MarketingScreen() {
  const canSend = usePermission('broadcast.send');
  const { branchId, branchName } = useBranchScope();
  const online = useOnline();
  const [composing, setComposing] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['broadcasts', branchId],
    queryFn: () => api<ListPayload>('/admin/broadcasts'),
    enabled: canSend,
  });

  if (!canSend) {
    return (
      <Page title="Marketing">
        <PermissionState what="Broadcasts" />
      </Page>
    );
  }

  return (
    <Page
      title="Marketing"
      kicker={branchName}
      actions={
        <div className="flex items-center gap-2">
          {!online ? <Chip tone="bad">Offline</Chip> : null}
          <Button variant="cta" disabled={!online || !list.data} onClick={() => setComposing(true)}>
            New broadcast
          </Button>
        </div>
      }
    >
      {list.data ? <ChannelStrip channels={list.data.channels} /> : null}
      {!online ? (
        <Panel tone="warn" className="p-3">
          <p className="text-[13px] text-foam-80">Offline. Nothing can be previewed or sent until the connection is back.</p>
        </Panel>
      ) : null}
      <div className="p-4">
        {list.isPending ? (
          <Skeleton className="h-40" />
        ) : list.isError ? (
          <ErrorState title="Could not load broadcasts" body="Try again in a moment." onRetry={() => void list.refetch()} />
        ) : list.data.items.length === 0 ? (
          <EmptyState
            title="No broadcasts yet"
            body={`A broadcast is one message to a group of members — holiday hours, a new class, a renewal offer. You see who it reaches and what it costs before anything goes. Sends to more than ${list.data.approvalThreshold} people need an owner's approval.`}
            action={
              <Button variant="outline" onClick={() => setComposing(true)}>
                New broadcast
              </Button>
            }
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {list.data.items.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(b.id)}
                  className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 border border-line bg-panel px-3.5 py-3 text-left hover:border-sonar"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px]">{b.name}</span>
                    <span className="block text-[12px] text-foam-65">
                      {b.channel.replace('_', '-')} · {b.purpose} · {b.createdRelative}
                    </span>
                  </span>
                  <span className="text-[12px] text-foam-80">{b.recipientCount} people</span>
                  <span className="text-[12px] text-foam-80">{formatMoney(b.estimatedCostMinor)}</span>
                  <Chip tone={STATE[b.state].tone}>{STATE[b.state].label}</Chip>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {composing && list.data ? (
        <Composer channels={list.data.channels} onClose={() => setComposing(false)} onCreated={(id) => setOpenId(id)} />
      ) : null}
      {openId ? <BroadcastDrawer broadcastId={openId} online={online} onClose={() => setOpenId(null)} /> : null}
    </Page>
  );
}

function PreviewPanel({ preview }: { preview: Preview }) {
  const excluded = Object.entries(preview.chosen.excluded).filter(([, n]) => n > 0);
  return (
    <Panel className="flex flex-col gap-2 p-3" aria-label="Who it reaches">
      <Label>Who it reaches</Label>
      <p className="text-[14px]">
        <strong>{preview.chosen.recipients}</strong> of {preview.segmentSize} people in this group will get it by {preview.chosen.label}.
      </p>
      {preview.chosen.heldForQuietHours > 0 ? (
        <p className="text-[12px] text-foam-65">{preview.chosen.heldForQuietHours} of them are in quiet hours now and will get it when quiet hours end.</p>
      ) : null}
      {excluded.length ? (
        <ul className="text-[12px] text-foam-65">
          {excluded.map(([code, n]) => (
            <li key={code}>
              {n} left out: {EXCLUSION_LABEL[code] ?? code}
            </li>
          ))}
        </ul>
      ) : null}
      <table className="mt-1 w-full text-left text-[12px]">
        <caption className="sr-only">Estimated cost by channel</caption>
        <thead>
          <tr className="text-foam-50">
            <th className="py-1 font-normal">Channel</th>
            <th className="py-1 font-normal">Reaches</th>
            <th className="py-1 font-normal">Per message</th>
            <th className="py-1 font-normal">Estimated cost</th>
          </tr>
        </thead>
        <tbody>
          {preview.byChannel.map((c) => (
            <tr key={c.channel} className={c.channel === preview.chosen.channel ? 'text-sonar' : 'text-foam-80'}>
              <td className="py-1">{c.label}</td>
              <td className="py-1">{c.recipients}</td>
              <td className="py-1">{formatMoney(c.ratePerMessageMinor)}</td>
              <td className="py-1">{formatMoney(c.estimatedCostMinor)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {preview.approvalRequired ? (
        <p className="text-[12px] text-flare">
          More than {preview.approvalThreshold} people: an owner has to approve this before it sends.
        </p>
      ) : null}
    </Panel>
  );
}

function Composer({ channels, onClose, onCreated }: { channels: ChannelAvailability[]; onClose: () => void; onCreated: (id: string) => void }) {
  const queryClient = useQueryClient();
  const branches = useAdmin((s) => s.branches);
  const activeBranchId = useAdmin((s) => s.activeBranchId);
  const [name, setName] = useState('');
  const [channel, setChannel] = useState<Channel>('in_app');
  const [purpose, setPurpose] = useState<'operational' | 'promotional'>('operational');
  const [statuses, setStatuses] = useState<string[]>(['active']);
  const [branch, setBranch] = useState(activeBranchId ?? '');
  const [tags, setTags] = useState('');
  const [notVisited, setNotVisited] = useState('');
  const [endsWithin, setEndsWithin] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [key] = useState(() => idempotencyKey('broadcast'));

  const input = {
    name: name.trim(),
    channel,
    purpose,
    segment: {
      ...(statuses.length ? { statuses } : {}),
      ...(branch ? { branchIds: [branch] } : {}),
      ...(tags.trim() ? { tags: tags.split(',').map((t) => t.trim()).filter(Boolean) } : {}),
      ...(notVisited ? { notVisitedForDays: Number(notVisited) } : {}),
      ...(endsWithin ? { membershipEndsWithinDays: Number(endsWithin) } : {}),
    },
    title: title.trim(),
    body: body.trim(),
  };
  const complete = input.name.length >= 3 && input.title.length >= 3 && input.body.length >= 3;

  const preview = useMutation({ mutationFn: () => api<Preview>('/admin/broadcasts/preview', { method: 'POST', body: input }) });
  const save = useMutation({
    mutationFn: () => api<{ broadcast: { id: string } }>('/admin/broadcasts', { method: 'POST', body: input, idempotencyKey: key }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['broadcasts'] });
      onClose();
      onCreated(result.broadcast.id);
    },
  });

  return (
    <Modal open title="New broadcast" onClose={onClose} width="w-[min(760px,100%)]">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (complete) save.mutate();
        }}
      >
        <Field label="Name (staff only)" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Diwali opening hours" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SelectField label="Channel" value={channel} onChange={(e) => setChannel(e.target.value as Channel)}>
            {channels.map((c) => (
              <option key={c.channel} value={c.channel}>
                {c.label} — {channelState(c)}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="What it is"
            hint={purpose === 'promotional' ? 'Offers need each member’s yes on that channel.' : 'Service news: sent unless they switched it off.'}
            value={purpose}
            onChange={(e) => setPurpose(e.target.value as 'operational' | 'promotional')}
          >
            <option value="operational">Gym news (hours, closures, class changes)</option>
            <option value="promotional">An offer or promotion</option>
          </SelectField>
        </div>
        <fieldset className="flex flex-col gap-2 border border-line p-3">
          <legend className="px-1 font-utility text-[10px] font-semibold uppercase tracking-[0.14em] text-foam-45">Who</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {STATUSES.map((s) => (
              <Checkbox
                key={s.value}
                label={s.label}
                checked={statuses.includes(s.value)}
                onChange={(e) => setStatuses((prev) => (e.target.checked ? [...prev, s.value] : prev.filter((v) => v !== s.value)))}
              />
            ))}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {branches.length > 1 ? (
              <SelectField label="Branch" value={branch} onChange={(e) => setBranch(e.target.value)}>
                <option value="">All my branches</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </SelectField>
            ) : null}
            <Field label="Tags (comma separated)" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="corporate, morning" />
            <Field label="Not visited for (days)" type="number" min={0} value={notVisited} onChange={(e) => setNotVisited(e.target.value)} />
            <Field label="Membership ends within (days)" type="number" min={0} value={endsWithin} onChange={(e) => setEndsWithin(e.target.value)} />
          </div>
        </fieldset>
        <Field label="Title" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
        <TextAreaField
          label="Message"
          hint="{{firstName}} is replaced with each member's first name."
          rows={4}
          maxLength={1000}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" disabled={!complete} pending={preview.isPending} pendingLabel="Checking" onClick={() => preview.mutate()}>
            Check who it reaches
          </Button>
          {preview.isError ? <span role="alert" className="text-[12px] text-chum">{failure(preview.error, 'Could not check the audience.')}</span> : null}
        </div>
        {preview.data ? <PreviewPanel preview={preview.data} /> : null}
        {save.isError ? <p role="alert" className="text-[12px] text-chum">{failure(save.error, 'The broadcast was not saved.')}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="cta" disabled={!complete} pending={save.isPending} pendingLabel="Saving">
            Save draft
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function BroadcastDrawer({ broadcastId, online, onClose }: { broadcastId: string; online: boolean; onClose: () => void }) {
  const canApprove = usePermission('broadcast.approve');
  const queryClient = useQueryClient();
  const [confirmSend, setConfirmSend] = useState(false);
  const [sendKey] = useState(() => idempotencyKey('broadcast-send', broadcastId));
  const detail = useQuery({
    queryKey: ['broadcasts', 'detail', broadcastId],
    queryFn: () =>
      api<{
        broadcast: BroadcastRow;
        preview: Preview | null;
        report: { counts: Record<string, number>; reasons: Array<{ reason: string; count: number }> } | null;
      }>(`/admin/broadcasts/${broadcastId}`),
  });
  const refresh = (): void => void queryClient.invalidateQueries({ queryKey: ['broadcasts'] });
  const dryRun = useMutation({
    mutationFn: () => api<{ preview: Preview }>(`/admin/broadcasts/${broadcastId}/dry-run`, { method: 'POST', body: {} }),
    onSuccess: refresh,
  });
  const approve = useMutation({ mutationFn: () => api(`/admin/broadcasts/${broadcastId}/approve`, { method: 'POST', body: {} }), onSuccess: refresh });
  const send = useMutation({
    mutationFn: () => api(`/admin/broadcasts/${broadcastId}/send`, { method: 'POST', body: {}, idempotencyKey: sendKey }),
    onSuccess: () => {
      setConfirmSend(false);
      refresh();
    },
    onError: refresh,
  });
  const cancel = useMutation({ mutationFn: () => api(`/admin/broadcasts/${broadcastId}/cancel`, { method: 'POST', body: {} }), onSuccess: refresh });

  const b = detail.data?.broadcast;
  return (
    <Drawer open title={b?.name ?? 'Broadcast'} onClose={onClose} width="w-[min(640px,100vw)]">
      {detail.isPending ? (
        <Skeleton className="h-48" />
      ) : detail.isError || !b ? (
        <ErrorState title="Could not open this broadcast" body="Try again." onRetry={() => void detail.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone={STATE[b.state].tone}>{STATE[b.state].label}</Chip>
            <span className="text-[12px] text-foam-65">
              {b.channel.replace('_', '-')} · {b.purpose}
            </span>
          </div>
          <Panel className="p-3">
            <p className="text-[13px] font-semibold">{b.title}</p>
            <p className="mt-1 whitespace-pre-wrap text-[13px] text-foam-80">{b.body}</p>
          </Panel>

          {detail.data.preview ? <PreviewPanel preview={detail.data.preview} /> : null}
          {dryRun.data ? (
            <p role="status" className="text-[12px] text-foam-65">
              Rehearsed: {dryRun.data.preview.chosen.recipients} would get it now. Nothing was sent.
            </p>
          ) : null}

          {detail.data.report ? (
            <Panel className="p-3" aria-label="Delivery report">
              <Label>What happened</Label>
              <dl className="mt-2 grid grid-cols-3 gap-2 text-[12px]">
                {['sent', 'logged', 'queued', 'deferred', 'suppressed', 'failed'].map((k) => (
                  <div key={k}>
                    <dt className="text-foam-50">{k === 'logged' ? 'logged, not delivered' : k}</dt>
                    <dd className="text-[14px]">{detail.data.report!.counts[k] ?? 0}</dd>
                  </div>
                ))}
              </dl>
              {detail.data.report.reasons.length ? (
                <ul className="mt-2 text-[12px] text-foam-65">
                  {detail.data.report.reasons.map((r) => (
                    <li key={r.reason}>
                      {r.count} × {r.reason}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Panel>
          ) : null}

          {b.state !== 'sent' && b.state !== 'cancelled' ? (
            <div className="flex flex-col gap-2">
              {b.state === 'awaiting_approval' && !canApprove ? (
                <p className="text-[12px] text-flare">Waiting for an owner to approve it. They will be asked to confirm it’s them.</p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" disabled={!online} pending={dryRun.isPending} pendingLabel="Rehearsing" onClick={() => dryRun.mutate()}>
                  Dry run
                </Button>
                {canApprove && b.approvalRequired && !b.approved ? (
                  <Button variant="outline" disabled={!online} pending={approve.isPending} onClick={() => approve.mutate()}>
                    Approve
                  </Button>
                ) : null}
                <Button variant="cta" disabled={!online || (b.state === 'awaiting_approval' && !b.approved)} onClick={() => setConfirmSend(true)}>
                  Send
                </Button>
                <Button variant="ghost" disabled={!online} pending={cancel.isPending} onClick={() => cancel.mutate()}>
                  Cancel broadcast
                </Button>
              </div>
              {[approve, send, cancel, dryRun].map((m, i) =>
                m.isError ? (
                  <p key={i} role="alert" className="text-[12px] text-chum">
                    {failure(m.error, 'That did not go through.')}
                  </p>
                ) : null,
              )}
            </div>
          ) : null}

          {confirmSend && detail.data.preview ? (
            <Modal open title="Send this broadcast?" onClose={() => setConfirmSend(false)}>
              <div className="flex flex-col gap-3">
                <p className="text-[13px] leading-relaxed">
                  {detail.data.preview.chosen.recipients} people get “{b.title}” by {detail.data.preview.chosen.label}. Estimated cost{' '}
                  {formatMoney(detail.data.preview.chosen.estimatedCostMinor)}. This cannot be unsent.
                </p>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setConfirmSend(false)}>
                    Not yet
                  </Button>
                  <Button variant="cta" pending={send.isPending} pendingLabel="Sending" onClick={() => send.mutate()}>
                    Send now
                  </Button>
                </div>
              </div>
            </Modal>
          ) : null}
        </div>
      )}
    </Drawer>
  );
}
