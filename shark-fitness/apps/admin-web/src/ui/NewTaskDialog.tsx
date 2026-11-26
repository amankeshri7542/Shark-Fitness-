import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, OfflineError, api, idempotencyKey } from '../lib/api';
import { useAdmin, usePermission, useViewer } from '../lib/store';
import { Button, Field, SelectField, TextAreaField } from './console';
import { Modal } from './overlay';

/**
 * "Create task" — one dialog for every place that offers it: the Tasks
 * screen, a Command Center alert, a member, a lead, and the command palette.
 * The caller pre-fills what it knows (title, the member or lead, the page the
 * task is about); the person adds who, when and how urgent.
 */
export interface TaskPrefill {
  title?: string;
  detail?: string;
  branchId?: string | null;
  memberId?: string;
  leadId?: string;
  link?: string;
}

interface Assignee {
  staffId: string;
  name: string;
  role: string;
}

export function NewTaskDialog({ open, onClose, prefill = {}, onCreated }: {
  open: boolean;
  onClose: () => void;
  prefill?: TaskPrefill;
  onCreated?: (taskId: string) => void;
}) {
  const branches = useAdmin((s) => s.branches);
  const activeBranchId = useAdmin((s) => s.activeBranchId);
  const viewer = useViewer();
  const canAssignOthers = usePermission('task.manage');
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(prefill.title ?? '');
  const [detail, setDetail] = useState(prefill.detail ?? '');
  const [branchId, setBranchId] = useState(prefill.branchId ?? activeBranchId ?? branches[0]?.id ?? '');
  const [assignee, setAssignee] = useState<string>('me');
  const [priority, setPriority] = useState('normal');
  const [due, setDue] = useState('');
  const [key] = useState(() => idempotencyKey('task'));

  const assignees = useQuery({
    queryKey: ['tasks', 'assignees', branchId],
    queryFn: () => api<{ items: Assignee[] }>(`/admin/tasks/assignees?branchId=${encodeURIComponent(branchId)}`),
    enabled: open && canAssignOthers && Boolean(branchId),
  });

  const save = useMutation({
    mutationFn: () =>
      api<{ task: { id: string } }>('/admin/tasks', {
        method: 'POST',
        idempotencyKey: key,
        body: {
          branchId,
          title: title.trim(),
          ...(detail.trim() ? { detail: detail.trim() } : {}),
          ...(assignee === 'me' ? {} : { assigneeStaffId: assignee === 'nobody' ? null : assignee }),
          priority,
          ...(due ? { dueAt: new Date(due).toISOString() } : {}),
          ...(prefill.memberId ? { memberId: prefill.memberId } : {}),
          ...(prefill.leadId ? { leadId: prefill.leadId } : {}),
          ...(prefill.link ? { link: prefill.link } : {}),
        },
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      onCreated?.(result.task.id);
      onClose();
    },
  });

  const error =
    save.error instanceof OfflineError
      ? 'No connection. The task was not created.'
      : save.error instanceof ApiError
        ? save.error.message
        : save.error
          ? 'The task was not created. Try again.'
          : null;

  return (
    <Modal open={open} title="New task" onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim().length >= 3 && branchId) save.mutate();
        }}
      >
        <Field label="What needs doing" value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} autoFocus required />
        <TextAreaField label="Details (optional)" value={detail} maxLength={2000} rows={2} onChange={(e) => setDetail(e.target.value)} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {branches.length > 1 ? (
            <SelectField label="Branch" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </SelectField>
          ) : null}
          <SelectField label="Who" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="me">Me{viewer?.name ? ` (${viewer.name})` : ''}</option>
            {canAssignOthers ? <option value="nobody">Nobody yet</option> : null}
            {(assignees.data?.items ?? [])
              .filter((s) => s.name !== viewer?.name)
              .map((s) => (
                <option key={s.staffId} value={s.staffId}>
                  {s.name}
                </option>
              ))}
          </SelectField>
          <SelectField label="Priority" value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </SelectField>
          <Field label="Due (optional)" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
        </div>
        {error ? (
          <p role="alert" className="text-[12px] text-chum">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="cta" disabled={title.trim().length < 3 || !branchId} pending={save.isPending} pendingLabel="Creating">
            Create task
          </Button>
        </div>
      </form>
    </Modal>
  );
}
