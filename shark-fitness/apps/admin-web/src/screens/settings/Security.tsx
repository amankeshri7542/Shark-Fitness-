import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { STAFF_IDLE_TIMEOUT_MINUTES, type SecuritySettings, type StaffMfaRow } from '@shark/contracts';
import { ApiError, OfflineError, api } from '../../lib/api';
import { useAdmin, usePermission } from '../../lib/store';
import { Button, Checkbox, Chip, EmptyState, ErrorState, Panel, PermissionState, SelectField, Skeleton, Table, TableScroll, TD, TH, THead, TR } from '../../ui/console';
import { ConfirmDialog } from '../../ui/overlay';

/* ============================================================================
   Settings → Security (PRD 04 ENT-IAM-001/003).

   Two rules the gym owns — two-step sign-in for every member of staff, and
   how long a staff session may sit idle — and a list of who has two-step
   sign-in, so an owner can see the gaps and clear a lost phone.
   ========================================================================= */

const IDLE_CHOICES = [15, 30, 60, 90, 120, 240].filter(
  (minutes) => minutes >= STAFF_IDLE_TIMEOUT_MINUTES.min && minutes <= STAFF_IDLE_TIMEOUT_MINUTES.max,
);

function messageOf(error: unknown): string {
  if (error instanceof OfflineError) return 'No connection. Check the network and try again.';
  if (error instanceof ApiError) return error.message;
  return 'That did not work. Try again.';
}

function idleLabel(minutes: number): string {
  return minutes < 60 ? `${minutes} minutes` : minutes === 60 ? '1 hour' : `${minutes / 60} hours`;
}

export default function Security({ canManage }: { canManage: boolean }) {
  const canSeeStaff = usePermission('staff.manage');
  if (!canManage) return <PermissionState what="Security settings" />;
  return (
    <div className="grid gap-px bg-line xl:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
      <div className="bg-abyss">
        <RulesPanel />
      </div>
      <div className="bg-abyss">{canSeeStaff ? <StaffPanel /> : <PermissionState what="Staff sign-in status" />}</div>
    </div>
  );
}

function RulesPanel() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings', 'security'], queryFn: () => api<SecuritySettings>('/admin/security/settings') });
  const [requireAll, setRequireAll] = useState(false);
  const [idle, setIdle] = useState<number>(STAFF_IDLE_TIMEOUT_MINUTES.default);
  useEffect(() => {
    if (!settings.data) return;
    setRequireAll(settings.data.requireMfaForStaff);
    setIdle(settings.data.staffIdleTimeoutMinutes);
  }, [settings.data]);
  const save = useMutation({
    mutationFn: () => api<SecuritySettings>('/admin/security/settings', { method: 'PATCH', body: { requireMfaForStaff: requireAll, staffIdleTimeoutMinutes: idle } }),
    onSuccess: (next) => queryClient.setQueryData(['settings', 'security'], next),
  });

  if (settings.isPending) {
    return (
      <Panel title="Sign-in rules">
        <div className="flex flex-col gap-3 p-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-1/2" />
        </div>
      </Panel>
    );
  }
  if (settings.isError) {
    return (
      <Panel title="Sign-in rules">
        <ErrorState title="Could not load security settings" body={messageOf(settings.error)} onRetry={() => void settings.refetch()} />
      </Panel>
    );
  }
  const dirty = requireAll !== settings.data.requireMfaForStaff || idle !== settings.data.staffIdleTimeoutMinutes;
  const choices = IDLE_CHOICES.includes(idle) ? IDLE_CHOICES : [...IDLE_CHOICES, idle].sort((a, b) => a - b);
  return (
    <Panel title="Sign-in rules">
      <form
        className="flex flex-col gap-4 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <Checkbox
          label="Require two-step sign-in for all staff"
          hint="Owners and regional managers always need it. Turning this on asks everyone else to set it up at their next sign-in."
          checked={requireAll}
          onChange={(event) => setRequireAll(event.target.checked)}
        />
        <SelectField
          label="Sign staff out after this long without activity"
          hint="Staff sign-ins also end 12 hours after signing in. Members are not affected."
          value={String(idle)}
          onChange={(event) => setIdle(Number(event.target.value))}
        >
          {choices.map((minutes) => (
            <option key={minutes} value={minutes}>
              {idleLabel(minutes)}
            </option>
          ))}
        </SelectField>
        {save.isError ? (
          <p role="alert" className="text-[12px] text-chum">
            {messageOf(save.error)}
          </p>
        ) : null}
        {save.isSuccess && !dirty ? (
          <p role="status" className="text-[12px] text-kelp">
            Saved.
          </p>
        ) : null}
        <div>
          <Button variant="cta" type="submit" disabled={!dirty} pending={save.isPending} pendingLabel="Saving…">
            Save rules
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function StaffPanel() {
  const queryClient = useQueryClient();
  const viewer = useAdmin((s) => s.viewer);
  const isOwner = viewer?.role === 'owner';
  const staff = useQuery({ queryKey: ['security', 'staff-mfa'], queryFn: () => api<{ items: StaffMfaRow[] }>('/admin/security/staff-mfa') });
  const [target, setTarget] = useState<StaffMfaRow | null>(null);
  const [reason, setReason] = useState('');
  const reset = useMutation({
    mutationFn: (row: StaffMfaRow) => api(`/admin/security/staff/${row.staffId}/mfa/reset`, { method: 'POST', body: { reason: reason.trim() } }),
    onSuccess: () => {
      setTarget(null);
      setReason('');
      void queryClient.invalidateQueries({ queryKey: ['security', 'staff-mfa'] });
    },
  });
  const missing = staff.data?.items.filter((row) => row.required && !row.enrolled).length ?? 0;

  return (
    <Panel title="Staff two-step sign-in" action={missing > 0 ? <Chip tone="warn">{missing} still to set up</Chip> : null}>
      {staff.isPending ? (
        <div className="flex flex-col gap-2 p-4">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : staff.isError ? (
        <ErrorState title="Could not load staff" body={messageOf(staff.error)} onRetry={() => void staff.refetch()} />
      ) : staff.data.items.length === 0 ? (
        <EmptyState title="No staff yet" body="People you add in Staff appear here with their sign-in status." />
      ) : (
        <TableScroll>
          <Table label="Staff two-step sign-in status">
            <THead>
              <TH>Name</TH>
              <TH>Role</TH>
              <TH>Two-step sign-in</TH>
              <TH>
                <span className="sr-only">Actions</span>
              </TH>
            </THead>
            <tbody>
              {staff.data.items.map((row) => (
                <TR key={row.staffId}>
                  <TD>{row.name}</TD>
                  <TD>{row.role.replace(/_/g, ' ')}</TD>
                  <TD>
                    {row.lockedUntil ? (
                      <Chip tone="bad">Locked after wrong codes</Chip>
                    ) : row.enrolled ? (
                      <Chip tone="good">On</Chip>
                    ) : row.required ? (
                      <Chip tone="warn">Required, not set up</Chip>
                    ) : (
                      <Chip tone="neutral">Off</Chip>
                    )}
                  </TD>
                  <TD>
                    {isOwner && row.enrolled && row.userId !== viewer?.userId ? (
                      <Button variant="ghost" onClick={() => setTarget(row)} aria-label={`Reset two-step sign-in for ${row.name}`}>
                        Reset
                      </Button>
                    ) : null}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </TableScroll>
      )}
      {!isOwner ? (
        <p className="border-t border-line p-3 text-[12px] text-foam-45">Only the gym owner can reset someone’s two-step sign-in.</p>
      ) : (
        <p className="border-t border-line p-3 text-[12px] text-foam-45">
          Lost your own phone? Use a recovery code, or contact Shark Fitness support, who will confirm it is you before resetting it.
        </p>
      )}
      <ConfirmDialog
        open={target !== null}
        onClose={() => {
          setTarget(null);
          setReason('');
        }}
        onConfirm={() => target && reset.mutate(target)}
        title={`Reset two-step sign-in for ${target?.name ?? ''}?`}
        consequence="Their authenticator and recovery codes stop working and they are signed out everywhere. At their next sign-in they set it up again. Check it is really them first — this is how an account is taken over."
        confirmLabel="Reset"
        reasonLabel="How you confirmed it is them (at least 8 characters)"
        reason={reason}
        onReasonChange={setReason}
        pending={reset.isPending}
        error={reset.isError ? messageOf(reset.error) : reason.trim().length > 0 && reason.trim().length < 8 ? 'Write at least 8 characters.' : null}
      />
    </Panel>
  );
}
