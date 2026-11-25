import { useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, OfflineError, api } from '../lib/api';
import { useBranchScope, useBranchTimeZone, usePermission } from '../lib/store';
import { useOnline } from '../lib/realtime';
import { Page } from '../ui/shell';
import {
  Button,
  Chip,
  EmptyState,
  ErrorState,
  Label,
  Panel,
  PermissionState,
  SelectField,
  Skeleton,
  Tabs,
  TextAreaField,
  type Tone,
} from '../ui/console';
import { Drawer } from '../ui/overlay';
import { NewTaskDialog } from '../ui/NewTaskDialog';

/* ============================================================================
   Tasks — the staff work queue (P07; PF-DASH-005, PF-SUP-004).

   An alert says something is wrong; a task says who is doing what about it
   and by when. Most tasks here were made by the generator from an alert (a
   lead past its follow-up, a failed payment, a member at risk, a safety work
   order, an unanswered waitlist seat); the rest were made by a person. Done
   means done *with an outcome* — what happened is the point.
   ========================================================================= */

export interface TaskRow {
  id: string;
  branchId: string;
  title: string;
  detail: string;
  source: string;
  sourceLabel: string;
  memberId: string | null;
  leadId: string | null;
  link: string | null;
  assignee: { staffId: string; name: string } | null;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  status: 'open' | 'in_progress' | 'done' | 'cancelled';
  dueAt: string | null;
  dueRelative: string | null;
  overdue: boolean;
  outcome: string | null;
  completedAt: string | null;
}

type View = 'mine' | 'open' | 'done';

const PRIORITY_TONE: Record<TaskRow['priority'], Tone> = { low: 'neutral', normal: 'neutral', high: 'warn', urgent: 'bad' };

function failure(error: unknown, fallback: string): string {
  if (error instanceof OfflineError) return 'No connection. Nothing was saved.';
  if (error instanceof ApiError) return error.message;
  return fallback;
}

export default function TasksScreen() {
  const canView = usePermission('task.view');
  const canManage = usePermission('task.manage');
  const { branchId, branchName } = useBranchScope();
  const timeZone = useBranchTimeZone();
  const online = useOnline();
  const search = useSearch({ strict: false }) as { view?: View; task?: string };
  const navigate = useNavigate();
  const view: View = search.view ?? 'mine';
  const setSearch = (next: { view?: View; task?: string | undefined }): void => {
    void navigate({ to: '/tasks', search: { view: next.view ?? view, ...(next.task ? { task: next.task } : {}) }, replace: true });
  };
  const [creating, setCreating] = useState(false);

  const tasks = useQuery({
    queryKey: ['tasks', 'list', branchId, view],
    queryFn: () => api<{ items: TaskRow[]; canManage: boolean }>(`/admin/tasks?view=${view}`),
    enabled: canView,
  });

  if (!canView) {
    return (
      <Page title="Tasks">
        <PermissionState what="The task queue" />
      </Page>
    );
  }

  const fmt = (iso: string) =>
    new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone }).format(new Date(iso));

  const tabs = [
    { key: 'mine', label: 'Mine' },
    ...(canManage ? [{ key: 'open', label: 'All open' }] : []),
    { key: 'done', label: 'Done' },
  ];

  return (
    <Page
      title="Tasks"
      kicker={branchName}
      actions={
        <div className="flex items-center gap-2">
          {!online ? <Chip tone="bad">Offline</Chip> : null}
          <Button variant="cta" disabled={!online} onClick={() => setCreating(true)}>
            New task
          </Button>
        </div>
      }
    >
      <Tabs label="Task lists" items={tabs} active={view} onChange={(key) => setSearch({ view: key as View })} />
      {!online ? (
        <Panel tone="warn" className="p-3">
          <p className="text-[13px] text-foam-80">Offline. What is on screen is the last list this machine saw; changes will not save.</p>
        </Panel>
      ) : null}
      <div role="tabpanel" id={`panel-${view}`} aria-labelledby={`tab-${view}`} className="p-4">
        {tasks.isPending ? (
          <div className="flex flex-col gap-2" aria-label="Loading tasks">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        ) : tasks.isError ? (
          <ErrorState title="Could not load tasks" body="This is not an empty list — the tasks could not be read." onRetry={() => void tasks.refetch()} />
        ) : tasks.data.items.length === 0 ? (
          <EmptyState
            title={view === 'done' ? 'Nothing finished yet' : view === 'mine' ? 'Nothing assigned to you' : 'No open tasks'}
            body={
              view === 'done'
                ? 'Finished tasks appear here with what happened.'
                : 'Tasks appear when something needs a person: a lead past its follow-up, a failed payment, a member at risk, a safety issue. You can also add your own.'
            }
            action={
              view !== 'done' ? (
                <Button variant="outline" onClick={() => setCreating(true)}>
                  New task
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {tasks.data.items.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  onClick={() => setSearch({ task: task.id })}
                  className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 border border-line bg-panel px-3.5 py-3 text-left hover:border-sonar"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] text-foam">{task.title}</span>
                    <span className="block truncate text-[12px] text-foam-65">
                      {task.sourceLabel}
                      {task.assignee ? ` · ${task.assignee.name}` : ' · Unassigned'}
                    </span>
                  </span>
                  <Chip tone={PRIORITY_TONE[task.priority]}>{task.priority}</Chip>
                  {task.status === 'in_progress' ? <Chip tone="accent">In progress</Chip> : null}
                  {task.status === 'done' ? <Chip tone="good">Done</Chip> : null}
                  {task.status === 'cancelled' ? <Chip tone="neutral">Cancelled</Chip> : null}
                  {task.dueAt && task.status !== 'done' ? (
                    <span className={task.overdue ? 'text-[12px] text-chum' : 'text-[12px] text-foam-65'}>
                      {task.overdue ? 'Overdue · ' : 'Due '}
                      {fmt(task.dueAt)}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {search.task ? (
        <TaskDrawer
          taskId={search.task}
          canManage={canManage}
          online={online}
          onClose={() => setSearch({ task: undefined })}
          fmt={fmt}
        />
      ) : null}
      {creating ? <NewTaskDialog open onClose={() => setCreating(false)} prefill={{ branchId }} /> : null}
    </Page>
  );
}

function TaskDrawer({ taskId, canManage, online, onClose, fmt }: {
  taskId: string;
  canManage: boolean;
  online: boolean;
  onClose: () => void;
  fmt: (iso: string) => string;
}) {
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState('');
  const detail = useQuery({
    queryKey: ['tasks', 'detail', taskId],
    queryFn: () => api<{ task: TaskRow }>(`/admin/tasks/${taskId}`),
  });
  const task = detail.data?.task;
  const assignees = useQuery({
    queryKey: ['tasks', 'assignees', task?.branchId],
    queryFn: () => api<{ items: Array<{ staffId: string; name: string }> }>(`/admin/tasks/assignees?branchId=${task!.branchId}`),
    enabled: canManage && Boolean(task),
  });
  const refresh = (): void => void queryClient.invalidateQueries({ queryKey: ['tasks'] });
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api(`/admin/tasks/${taskId}`, { method: 'PATCH', body }),
    onSuccess: refresh,
  });
  const complete = useMutation({
    mutationFn: () => api(`/admin/tasks/${taskId}/complete`, { method: 'POST', body: { outcome: outcome.trim() } }),
    onSuccess: () => {
      setOutcome('');
      refresh();
    },
  });

  return (
    <Drawer open title={task?.title ?? 'Task'} onClose={onClose}>
      {detail.isPending ? (
        <Skeleton className="h-40" />
      ) : detail.isError || !task ? (
        <ErrorState
          title="Could not open this task"
          body={detail.error instanceof ApiError && detail.error.status === 404 ? 'It is not in your branches, or it is assigned to someone else.' : 'Try again.'}
          onRetry={() => void detail.refetch()}
        />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone={PRIORITY_TONE[task.priority]}>{task.priority}</Chip>
            <span className="text-[12px] text-foam-65">{task.sourceLabel}</span>
          </div>
          {task.detail ? <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foam-80">{task.detail}</p> : null}
          {task.link ? (
            <Link to={task.link} className="self-start text-[13px] text-sonar underline">
              {task.memberId ? 'Open the member' : task.leadId ? 'Open the lead' : 'Open what this is about'}
            </Link>
          ) : null}
          {task.dueAt ? <p className="text-[12px] text-foam-65">{task.overdue ? 'Overdue since' : 'Due'} {fmt(task.dueAt)}</p> : null}

          {task.status === 'done' ? (
            <Panel className="p-3">
              <Label>Outcome</Label>
              <p className="mt-1 text-[13px]">{task.outcome}</p>
              {task.completedAt ? <p className="mt-1 text-[11px] text-foam-50">Finished {fmt(task.completedAt)}</p> : null}
            </Panel>
          ) : task.status === 'cancelled' ? (
            <p className="text-[13px] text-foam-65">This task was cancelled.</p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {canManage ? (
                  <SelectField
                    label="Assigned to"
                    value={task.assignee?.staffId ?? ''}
                    disabled={!online || patch.isPending}
                    onChange={(e) => patch.mutate({ assigneeStaffId: e.target.value || null })}
                  >
                    <option value="">Nobody yet</option>
                    {(assignees.data?.items ?? []).map((s) => (
                      <option key={s.staffId} value={s.staffId}>
                        {s.name}
                      </option>
                    ))}
                  </SelectField>
                ) : null}
                <SelectField
                  label="Status"
                  value={task.status}
                  disabled={!online || patch.isPending}
                  onChange={(e) => patch.mutate({ status: e.target.value })}
                >
                  <option value="open">Not started</option>
                  <option value="in_progress">In progress</option>
                  {canManage ? <option value="cancelled">Cancelled</option> : null}
                </SelectField>
              </div>
              {patch.isError ? <p role="alert" className="text-[12px] text-chum">{failure(patch.error, 'That change did not save.')}</p> : null}
              <form
                className="flex flex-col gap-2 border-t border-line pt-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (outcome.trim().length >= 3) complete.mutate();
                }}
              >
                <TextAreaField
                  label="What happened"
                  hint="Required to finish. The next person reads this."
                  rows={3}
                  maxLength={2000}
                  value={outcome}
                  onChange={(e) => setOutcome(e.target.value)}
                />
                {complete.isError ? <p role="alert" className="text-[12px] text-chum">{failure(complete.error, 'The task was not finished.')}</p> : null}
                <Button type="submit" variant="cta" disabled={!online || outcome.trim().length < 3} pending={complete.isPending} pendingLabel="Saving">
                  Mark done
                </Button>
              </form>
            </>
          )}
        </div>
      )}
    </Drawer>
  );
}
