import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiDownload, saveBlob } from '../../lib/api';
import { usePermission } from '../../lib/store';
import { Drawer } from '../../ui/overlay';
import { BulkBar, Button, Field, Label, Segmented } from '../../ui/console';

/**
 * The Members directory bulk bar (Design PRD §5.5): tag, assign a coach,
 * message, export. Each action is one drawer and one confirm at most — export
 * has no drawer at all, because there is nothing to choose.
 *
 * Buttons a role cannot use are not shown. The server still decides; this
 * only saves the operator a click that would be refused.
 */

export interface BulkMember {
  id: string;
  name: string;
  tags: string[];
}

interface BulkResult {
  message: string;
}

interface Trainer {
  id: string;
  name: string;
  memberCount: number;
}

type Panel = 'tag' | 'trainer' | 'message' | null;

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : 'That did not go through. Nothing has changed.';

export function MembersBulkActions({
  members,
  branchId,
  onClear,
}: {
  members: BulkMember[];
  branchId: string | null;
  onClear: () => void;
}) {
  const queryClient = useQueryClient();
  const canEdit = usePermission('member.edit');
  const canExport = usePermission('report.export');

  const [panel, setPanel] = useState<Panel>(null);
  const [status, setStatus] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  const memberIds = members.map((m) => m.id);
  const count = members.length;

  const finish = (result: BulkResult): void => {
    setStatus({ tone: 'good', text: result.message });
    setPanel(null);
    onClear();
    void queryClient.invalidateQueries({ queryKey: ['members'] });
  };

  const exportCsv = useMutation({
    mutationFn: () => apiDownload('/admin/members/bulk/export', { body: { memberIds }, branchId }),
    onSuccess: ({ blob, filename }) => {
      saveBlob(blob, filename ?? 'members.csv');
      setStatus({ tone: 'good', text: `Exported ${count} ${count === 1 ? 'member' : 'members'} to CSV.` });
    },
    onError: (error) => setStatus({ tone: 'bad', text: errorText(error) }),
  });

  return (
    <>
      <BulkBar
        count={count}
        onClear={() => {
          setStatus(null);
          onClear();
        }}
      >
        {canEdit ? (
          <>
            <Button variant="outline" onClick={() => setPanel('tag')}>
              Add tag
            </Button>
            <Button variant="outline" onClick={() => setPanel('trainer')}>
              Assign trainer
            </Button>
            <Button variant="outline" onClick={() => setPanel('message')}>
              Message
            </Button>
          </>
        ) : null}
        {canExport ? (
          <Button variant="outline" onClick={() => exportCsv.mutate()} disabled={exportCsv.isPending}>
            {exportCsv.isPending ? 'Exporting…' : 'Export CSV'}
          </Button>
        ) : null}
      </BulkBar>

      {status ? (
        <p
          role="status"
          className={
            status.tone === 'good'
              ? 'border-b border-line px-3.5 py-2 text-[12px] text-kelp'
              : 'border-b border-line px-3.5 py-2 text-[12px] text-chum'
          }
        >
          {status.text}
        </p>
      ) : null}

      <TagDrawer
        open={panel === 'tag'}
        onClose={() => setPanel(null)}
        members={members}
        branchId={branchId}
        onDone={finish}
      />
      <TrainerDrawer
        open={panel === 'trainer'}
        onClose={() => setPanel(null)}
        memberIds={memberIds}
        branchId={branchId}
        onDone={finish}
      />
      <MessageDrawer
        open={panel === 'message'}
        onClose={() => setPanel(null)}
        memberIds={memberIds}
        branchId={branchId}
        onDone={finish}
      />
    </>
  );
}

function selectionLabel(n: number): string {
  return `${n} ${n === 1 ? 'member' : 'members'} selected`;
}

/* ——— Tag ——————————————————————————————————————————————————— */

function TagDrawer({
  open,
  onClose,
  members,
  branchId,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  members: BulkMember[];
  branchId: string | null;
  onDone: (result: BulkResult) => void;
}) {
  const [tag, setTag] = useState('');
  const [mode, setMode] = useState<'add' | 'remove'>('add');

  // Tags already on the selection are the likeliest to be removed, and the
  // likeliest to be reused, so they are one click away either way.
  const existing = [...new Set(members.flatMap((m) => m.tags))].sort();

  const save = useMutation({
    mutationFn: () =>
      api<BulkResult>('/admin/members/bulk/tag', {
        method: 'POST',
        body: { memberIds: members.map((m) => m.id), tag, mode },
        branchId,
      }),
    onSuccess: (result) => {
      setTag('');
      onDone(result);
    },
  });

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={mode === 'add' ? 'Add tag' : 'Remove tag'}
      kicker={selectionLabel(members.length)}
      footer={
        <div className="flex items-center gap-2">
          {save.error ? <p className="flex-1 text-[12px] text-chum">{errorText(save.error)}</p> : <span className="flex-1" />}
          <Button variant="cta" onClick={() => save.mutate()} disabled={!tag.trim() || save.isPending}>
            {save.isPending ? 'Saving…' : mode === 'add' ? 'Add tag' : 'Remove tag'}
          </Button>
        </div>
      }
    >
      <form
        className="flex flex-col gap-3 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (tag.trim()) save.mutate();
        }}
      >
        <Segmented
          label="Add or remove"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'add', label: 'Add' },
            { value: 'remove', label: 'Remove' },
          ]}
        />
        <Field
          label="Tag"
          placeholder="e.g. pt-client"
          hint="Letters, numbers or dashes. Spaces become dashes."
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          autoFocus
        />
        {existing.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <Label>On this selection</Label>
            <div className="flex flex-wrap gap-1.5">
              {existing.map((t) => (
                <Button key={t} variant={tag === t ? 'cta' : 'outline'} onClick={() => setTag(t)}>
                  {t}
                </Button>
              ))}
            </div>
          </div>
        ) : null}
      </form>
    </Drawer>
  );
}

/* ——— Trainer ——————————————————————————————————————————————— */

function TrainerDrawer({
  open,
  onClose,
  memberIds,
  branchId,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  memberIds: string[];
  branchId: string | null;
  onDone: (result: BulkResult) => void;
}) {
  const trainers = useQuery({
    queryKey: ['members', 'trainers', branchId],
    queryFn: () => api<{ items: Trainer[] }>('/admin/members/trainers', { branchId }),
    enabled: open,
  });

  const assign = useMutation({
    mutationFn: (trainerId: string | null) =>
      api<BulkResult>('/admin/members/bulk/trainer', {
        method: 'POST',
        body: { memberIds, trainerId },
        branchId,
      }),
    onSuccess: onDone,
  });

  return (
    <Drawer open={open} onClose={onClose} title="Assign trainer" kicker={selectionLabel(memberIds.length)}>
      <div className="flex flex-col">
        {assign.error ? <p className="px-4 pt-3 text-[12px] text-chum">{errorText(assign.error)}</p> : null}
        {trainers.isLoading ? <p className="p-4 text-[12px] text-foam-45">Loading trainers…</p> : null}
        {trainers.error ? <p className="p-4 text-[12px] text-chum">Could not load trainers.</p> : null}
        {trainers.data?.items.length === 0 ? (
          <p className="p-4 text-[12px] text-foam-45">No active trainers work at this branch.</p>
        ) : null}
        {/* One click assigns: the list is the confirmation. */}
        {trainers.data?.items.map((t) => (
          <button
            key={t.id}
            type="button"
            disabled={assign.isPending}
            onClick={() => assign.mutate(t.id)}
            className="flex items-center justify-between border-b border-line px-4 py-3 text-left hover:bg-wash-sonar disabled:opacity-40"
          >
            <span className="text-[13px]">{t.name}</span>
            <span className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-45">
              {t.memberCount} {t.memberCount === 1 ? 'member' : 'members'}
            </span>
          </button>
        ))}
        {trainers.data ? (
          <div className="p-4">
            <Button variant="ghost" disabled={assign.isPending} onClick={() => assign.mutate(null)}>
              Remove coach
            </Button>
          </div>
        ) : null}
      </div>
    </Drawer>
  );
}

/* ——— Message ——————————————————————————————————————————————— */

function MessageDrawer({
  open,
  onClose,
  memberIds,
  branchId,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  memberIds: string[];
  branchId: string | null;
  onDone: (result: BulkResult) => void;
}) {
  const [body, setBody] = useState('');

  const send = useMutation({
    mutationFn: () =>
      api<BulkResult>('/admin/members/bulk/message', {
        method: 'POST',
        body: { memberIds, body },
        branchId,
      }),
    onSuccess: (result) => {
      setBody('');
      onDone(result);
    },
  });

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Message members"
      kicker={selectionLabel(memberIds.length)}
      footer={
        <div className="flex items-center gap-2">
          {send.error ? <p className="flex-1 text-[12px] text-chum">{errorText(send.error)}</p> : <span className="flex-1" />}
          <Button variant="cta" onClick={() => send.mutate()} disabled={!body.trim() || send.isPending}>
            {send.isPending ? 'Sending…' : `Send to ${memberIds.length}`}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-2 p-4">
        <label className="flex flex-col gap-1">
          <span className="font-utility text-[10px] font-semibold uppercase tracking-[0.14em] text-foam-45">Message</span>
          <textarea
            className="sf-field !min-h-[140px] !text-[13px]"
            value={body}
            maxLength={1000}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Each member gets this in their reception chat in the app."
            autoFocus
          />
        </label>
        <p className="text-[11px] text-foam-45">
          {body.length}/1000. Delivered in the member app only. SMS, WhatsApp and email are not connected yet.
        </p>
      </div>
    </Drawer>
  );
}
