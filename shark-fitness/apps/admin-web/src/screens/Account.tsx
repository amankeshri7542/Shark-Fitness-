import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DeviceSession, MfaStatus } from '@shark/contracts';
import { ApiError, OfflineError, api } from '../lib/api';
import { useAdmin, useBranchTimeZone } from '../lib/store';
import { Page } from '../ui/shell';
import { Button, Chip, EmptyState, ErrorState, Panel, Skeleton, Table, TableScroll, TD, TH, THead, TR } from '../ui/console';
import { ConfirmDialog, Modal } from '../ui/overlay';
import { MfaEnrolmentFlow, RecoveryCodes } from '../ui/TwoStep';

/* ============================================================================
   Your account — two-step sign-in and the devices signed in as you
   (PRD 04 ENT-IAM-003 "session revocation, and device visibility").

   Every member of staff can reach it, whatever their role: it is about their
   own sign-in, not the gym. Changing a factor asks for a fresh password and
   code first (the step-up dialog comes from the API, not from this screen).
   ========================================================================= */

function messageOf(error: unknown): string {
  if (error instanceof OfflineError) return 'No connection. Check the network and try again.';
  if (error instanceof ApiError) return error.message;
  return 'That did not work. Try again.';
}

function when(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString('en-IN', { timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export default function AccountScreen() {
  const impersonating = useAdmin((s) => s.impersonation !== null);
  return (
    <Page title="Your account" kicker="Sign-in and security">
      <div className="grid gap-px bg-line lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="bg-abyss">
          {impersonating ? (
            <Panel title="Two-step sign-in">
              <p className="p-4 text-[13px] leading-relaxed text-foam-65">
                This is a support session. Two-step sign-in belongs to the account holder and cannot be changed from here.
              </p>
            </Panel>
          ) : (
            <TwoStepPanel />
          )}
        </div>
        <div className="bg-abyss">
          <DevicesPanel />
        </div>
      </div>
    </Page>
  );
}

function TwoStepPanel() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ['mfa', 'status'], queryFn: () => api<MfaStatus>('/auth/mfa') });
  const [enrolling, setEnrolling] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const regenerate = useMutation({
    mutationFn: () => api<{ recoveryCodes: string[] }>('/auth/mfa/recovery-codes', { method: 'POST' }),
    onSuccess: (result) => {
      setCodes(result.recoveryCodes);
      void queryClient.invalidateQueries({ queryKey: ['mfa', 'status'] });
    },
  });
  const turnOff = useMutation({
    mutationFn: () => api<{ sessionState: 'none' | 'enrol' }>('/auth/mfa', { method: 'DELETE' }),
    onSuccess: (result) => {
      setConfirmOff(false);
      // Where MFA is required, this session now owes a new enrolment.
      if (result.sessionState === 'enrol') useAdmin.getState().setMfaPending('enrol');
      void queryClient.invalidateQueries({ queryKey: ['mfa', 'status'] });
    },
  });

  return (
    <Panel title="Two-step sign-in">
      <div className="flex flex-col gap-3 p-4">
        {status.isPending ? (
          <>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-16 w-full" />
          </>
        ) : status.isError ? (
          <ErrorState title="Could not load" body={messageOf(status.error)} onRetry={() => void status.refetch()} />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {status.data.enrolled ? <Chip tone="good">On</Chip> : <Chip tone={status.data.required ? 'bad' : 'neutral'}>Off</Chip>}
              {status.data.required ? (
                <Chip tone="neutral">{status.data.requiredBy === 'gym' ? 'Required by your gym' : 'Required for your role'}</Chip>
              ) : null}
            </div>
            <p className="text-[13px] leading-relaxed text-foam-65">
              {status.data.enrolled
                ? `Signing in asks for a code from your authenticator app after your password. ${status.data.recoveryCodesRemaining} of 10 recovery codes left.`
                : 'Add a code from an authenticator app to your password, so a stolen password alone cannot open your account.'}
            </p>
            {status.data.enrolled && status.data.recoveryCodesRemaining <= 3 ? (
              <p role="status" className="border border-flare bg-wash-flare p-2.5 text-[12px]">
                You are running low on recovery codes. Make a new set and store it safely.
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {status.data.enrolled ? (
                <>
                  <Button variant="outline" pending={regenerate.isPending} pendingLabel="Working…" onClick={() => regenerate.mutate()}>
                    New recovery codes
                  </Button>
                  <Button variant="danger" onClick={() => setConfirmOff(true)}>
                    {status.data.required ? 'Move to a new phone' : 'Turn off'}
                  </Button>
                </>
              ) : (
                <Button variant="cta" onClick={() => setEnrolling(true)}>
                  Set up
                </Button>
              )}
            </div>
            {regenerate.isError ? <p role="alert" className="text-[12px] text-chum">{messageOf(regenerate.error)}</p> : null}
          </>
        )}
      </div>

      <Modal open={enrolling} onClose={() => setEnrolling(false)} title="Set up two-step sign-in" kicker="Your account" width="w-[min(620px,100%)]">
        <div className="p-4">
          {enrolling ? (
            <MfaEnrolmentFlow
              doneLabel="Done"
              onEnrolled={() => {
                setEnrolling(false);
                void queryClient.invalidateQueries({ queryKey: ['mfa', 'status'] });
              }}
            />
          ) : null}
        </div>
      </Modal>

      <Modal open={codes !== null} onClose={() => setCodes(null)} title="New recovery codes" kicker="Your old codes no longer work">
        <div className="p-4">{codes ? <RecoveryCodes codes={codes} doneLabel="Done" onDone={() => setCodes(null)} /> : null}</div>
      </Modal>

      <ConfirmDialog
        open={confirmOff}
        onClose={() => setConfirmOff(false)}
        onConfirm={() => turnOff.mutate()}
        title={status.data?.required ? 'Move two-step sign-in to a new phone?' : 'Turn off two-step sign-in?'}
        consequence={
          status.data?.required
            ? 'Your current authenticator and recovery codes stop working. Because your role or gym requires two-step sign-in, you will set it up again straight away with the new phone.'
            : 'Your authenticator and recovery codes stop working, and signing in needs only your password.'
        }
        confirmLabel={status.data?.required ? 'Continue' : 'Turn off'}
        pending={turnOff.isPending}
        error={turnOff.isError ? messageOf(turnOff.error) : null}
      />
    </Panel>
  );
}

function DevicesPanel() {
  const queryClient = useQueryClient();
  const timeZone = useBranchTimeZone();
  const impersonating = useAdmin((s) => s.impersonation !== null);
  const sessions = useQuery({ queryKey: ['me', 'sessions'], queryFn: () => api<{ items: DeviceSession[] }>('/me/sessions') });
  const [revoking, setRevoking] = useState<DeviceSession | null>(null);
  const [everywhere, setEverywhere] = useState(false);
  const revoke = useMutation({
    mutationFn: (sessionId: string) => api(`/me/sessions/${sessionId}`, { method: 'DELETE' }),
    onSuccess: () => {
      setRevoking(null);
      void queryClient.invalidateQueries({ queryKey: ['me', 'sessions'] });
    },
  });
  const others = useMutation({
    mutationFn: () => api<{ revoked: number }>('/me/sessions/sign-out-others', { method: 'POST' }),
    onSuccess: () => {
      setEverywhere(false);
      void queryClient.invalidateQueries({ queryKey: ['me', 'sessions'] });
    },
  });
  const otherCount = sessions.data?.items.filter((item) => !item.current).length ?? 0;

  return (
    <Panel
      title="Your devices"
      action={
        otherCount > 0 && !impersonating ? (
          <Button variant="outline" onClick={() => setEverywhere(true)}>
            Sign out everywhere else
          </Button>
        ) : null
      }
    >
      {sessions.isPending ? (
        <div className="flex flex-col gap-2 p-4">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : sessions.isError ? (
        <ErrorState title="Could not load your devices" body={messageOf(sessions.error)} onRetry={() => void sessions.refetch()} />
      ) : (
        <>
          <TableScroll>
            <Table label="Devices signed in as you">
              <THead>
                <TR>
                  <TH>Device</TH>
                  <TH>Last active</TH>
                  <TH>Signed in</TH>
                  <TH>IP address</TH>
                  <TH>
                    <span className="sr-only">Actions</span>
                  </TH>
                </TR>
              </THead>
              <tbody>
                {sessions.data.items.map((item) => (
                  <TR key={item.id}>
                    <TD>
                      <span className="flex flex-wrap items-center gap-2">
                        {item.device}
                        {item.current ? <Chip tone="accent">This device</Chip> : null}
                      </span>
                    </TD>
                    <TD>{when(item.lastActiveAt, timeZone)}</TD>
                    <TD>{when(item.createdAt, timeZone)}</TD>
                    <TD>{item.ip || '—'}</TD>
                    <TD>
                      {item.current || impersonating ? null : (
                        <Button variant="ghost" onClick={() => setRevoking(item)} aria-label={`Sign out ${item.device}, last active ${when(item.lastActiveAt, timeZone)}`}>
                          Sign out
                        </Button>
                      )}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </TableScroll>
          {otherCount === 0 ? (
            <EmptyState title="Only this device" body="You are not signed in anywhere else. Staff sign-ins end after 12 hours, or sooner when left idle." />
          ) : null}
        </>
      )}

      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
        title={`Sign out ${revoking?.device ?? 'this device'}?`}
        consequence="Anyone using that sign-in is sent back to the sign-in screen at their next action."
        confirmLabel="Sign out"
        pending={revoke.isPending}
        error={revoke.isError ? messageOf(revoke.error) : null}
      />
      <ConfirmDialog
        open={everywhere}
        onClose={() => setEverywhere(false)}
        onConfirm={() => others.mutate()}
        title="Sign out everywhere else?"
        consequence={`Ends ${otherCount} other sign-in${otherCount === 1 ? '' : 's'}. This device stays signed in.`}
        confirmLabel="Sign out others"
        pending={others.isPending}
        error={others.isError ? messageOf(others.error) : null}
      />
    </Panel>
  );
}
