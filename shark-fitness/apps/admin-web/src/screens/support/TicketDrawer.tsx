import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TicketDetail, TicketPriority, TicketState } from '@shark/contracts';
import { ApiError, OfflineError, api } from '../../lib/api';
import { useIdempotentAttempt } from '../../lib/idempotent-attempt';
import { Button, Chip, ErrorState, Label, Segmented, Skeleton, cx } from '../../ui/console';
import { ConfirmDialog, Drawer } from '../../ui/overlay';
import {
  CATEGORY_LABEL,
  PriorityChip,
  Restricted,
  SlaChip,
  TicketStateChip,
  dateTime,
  money,
  since,
  stateLabel,
} from './shared';

/* ============================================================================
   Ticket detail (PF-SUP-001, PF-SUP-006).

   Four things, in the order a person answering the ticket needs them: what was
   promised and whether it has been kept; who the member is; the conversation;
   and the immutable record of everything anyone did to it.

   Deliberately not a KPI wall. The only numbers here are the ones that change
   what you type next — the reply clock, the member's balance, how many other
   tickets they have open.
   ========================================================================= */

export default function TicketDrawer({
  ticketId,
  timeZone,
  online,
  onClose,
  onChanged,
}: {
  ticketId: string;
  timeZone: string;
  online: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [reply, setReply] = useState('');
  const [internal, setInternal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolution, setResolution] = useState('');
  const [escalateOpen, setEscalateOpen] = useState(false);
  const [escalateReason, setEscalateReason] = useState('');
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenReason, setReopenReason] = useState('');

  /* One reply, one key.

     A support reply is visible to the member the moment it lands, so a retry
     after a lost response must not send the same answer twice. The key is
     minted against the text being sent and retired once the server has taken
     it, so editing the draft mints a new one. */
  const attempt = useIdempotentAttempt('support-reply', ticketId);

  const detail = useQuery({
    queryKey: ['support', 'ticket', ticketId],
    queryFn: () => api<TicketDetail>(`/admin/support/tickets/${ticketId}`),
  });

  const settle = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['support'] });
    onChanged();
  };

  const sendReply = useMutation({
    mutationFn: () => {
      const payload = { body: reply.trim(), internal };
      return api<TicketDetail>(`/admin/support/tickets/${ticketId}/reply`, {
        method: 'POST',
        idempotencyKey: attempt.keyFor(payload),
        body: payload,
      });
    },
    onSuccess: () => {
      setReply('');
      setError(null);
      attempt.retire();
      settle();
      void detail.refetch();
    },
    onError: (e) =>
      setError(
        e instanceof OfflineError
          ? 'No connection. Nothing was sent — the member has not seen anything.'
          : e instanceof ApiError
            ? e.message
            : 'The reply did not send.',
      ),
  });

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<TicketDetail>(`/admin/support/tickets/${ticketId}`, { method: 'PATCH', body }),
    onSuccess: () => {
      setError(null);
      settle();
      void detail.refetch();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'That change did not save.'),
  });

  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body: Record<string, unknown> }) =>
      api<TicketDetail>(`/admin/support/tickets/${ticketId}/${path}`, { method: 'POST', body }),
    onSuccess: () => {
      setResolveOpen(false);
      setEscalateOpen(false);
      setReopenOpen(false);
      setResolution('');
      setEscalateReason('');
      setReopenReason('');
      setError(null);
      settle();
      void detail.refetch();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'That did not go through.'),
  });

  const ticket = detail.data?.ticket;
  const member = detail.data?.member ?? null;
  const blocked = detail.data?.replyBlockedReason ?? null;
  const terminal = ticket?.state === 'closed';
  const canAct = online && !detail.isError && ticket !== undefined;

  return (
    <>
      <Drawer
        open
        onClose={onClose}
        // Wider than the default sheet: a conversation, a member card and a
        // timeline at 560px turns every line into three.
        width="w-[min(760px,100vw)]"
        kicker={ticket ? `${CATEGORY_LABEL[ticket.category] ?? ticket.category} · ${since(ticket.openedAt)}` : 'Support'}
        title={ticket?.reference ?? 'Ticket'}
        footer={
          canAct && ticket ? (
            <div className="flex flex-wrap items-center gap-2">
              {ticket.state === 'resolved' || terminal ? (
                <Button variant="outline" disabled={terminal} onClick={() => setReopenOpen(true)}>
                  {terminal ? 'Closed for good' : 'Reopen'}
                </Button>
              ) : (
                <>
                  {!ticket.escalated ? (
                    <Button variant="danger" onClick={() => setEscalateOpen(true)}>
                      Escalate
                    </Button>
                  ) : null}
                  <Button variant="cta" className="flex-1" onClick={() => setResolveOpen(true)}>
                    Resolve
                  </Button>
                </>
              )}
            </div>
          ) : null
        }
      >
        {detail.isError ? (
          <ErrorState
            title="Could not load this ticket"
            body="The API did not answer. Nothing has changed on the ticket — close this and try again."
            onRetry={() => void detail.refetch()}
          />
        ) : detail.isPending || !ticket ? (
          <Skeleton className="m-3 h-64" />
        ) : (
          <>
            {/* — What was promised, and whether it was kept. — */}
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
              <TicketStateChip state={ticket.state} />
              <PriorityChip priority={ticket.priority} />
              <SlaChip state={ticket.sla.state} label={ticket.sla.label} />
              {ticket.escalated ? <Chip tone="bad">Escalated</Chip> : null}
              {ticket.vulnerabilityFlag ? <Chip tone="warn">Vulnerable — no automation</Chip> : null}
              {ticket.branchName ? <span className="text-[12px] text-foam-45">{ticket.branchName}</span> : null}
            </div>

            <h3 className="border-b border-line px-3 py-2.5 text-[15px] leading-snug">{ticket.subject}</h3>

            {ticket.safetyCategories.length > 0 ? (
              <p className="border-b border-line bg-wash-chum px-3 py-2 text-[12px] leading-relaxed text-foam-80">
                The member’s own words tripped a safety pattern
                {` (${ticket.safetyCategories.join(', ')})`}. A person answers this one — nothing automated will
                contact them, and the reply time was shortened accordingly.
              </p>
            ) : null}

            {detail.data?.escalation ? (
              <p className="border-b border-line bg-wash-flare px-3 py-2 text-[12px] leading-relaxed text-foam-80">
                Escalated by {detail.data.escalation.by} on {dateTime(detail.data.escalation.at, timeZone)} —{' '}
                {detail.data.escalation.reason}. Escalation is part of the permanent record and cannot be lifted.
              </p>
            ) : null}

            {/* — Ownership. Two controls, both immediate. — */}
            <section className="grid gap-px border-b border-line bg-line sm:grid-cols-2">
              <div className="bg-panel px-3 py-2">
                <Label>Owner</Label>
                <div className="mt-1">
                  <AssigneeSelect
                    value={ticket.assigneeId}
                    disabled={!online || terminal || patch.isPending}
                    onChange={(assigneeId) => patch.mutate({ assigneeId })}
                  />
                </div>
              </div>
              <div className="bg-panel px-3 py-2">
                <Label>Priority</Label>
                <div className="mt-1">
                  <Segmented
                    label="Ticket priority"
                    value={ticket.priority}
                    onChange={(priority: TicketPriority) => patch.mutate({ priority })}
                    options={[
                      { value: 'low' as TicketPriority, label: 'Low' },
                      { value: 'normal' as TicketPriority, label: 'Normal' },
                      { value: 'high' as TicketPriority, label: 'High' },
                      { value: 'urgent' as TicketPriority, label: 'Urgent' },
                    ]}
                  />
                </div>
              </div>
            </section>

            {!terminal && ticket.state !== 'resolved' ? (
              <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
                <Label>Move to</Label>
                {(['open', 'pending_staff', 'pending_member'] as TicketState[])
                  .filter((s) => s !== ticket.state)
                  .map((s) => (
                    <Button key={s} disabled={!online || patch.isPending} onClick={() => patch.mutate({ state: s })}>
                      {stateLabel(s)}
                    </Button>
                  ))}
              </div>
            ) : null}

            {/* — Who they are. Enough to answer without leaving the ticket. — */}
            {member ? (
              <section className="border-b border-line">
                <div className="flex items-center gap-2 px-3 py-2">
                  <Label>Member</Label>
                  {member.inactive ? <Chip tone="bad">Record deleted</Chip> : null}
                  <span className="flex-1" />
                  {member.riskBand ? (
                    <Chip tone={member.riskBand === 'high' ? 'bad' : member.riskBand === 'watch' ? 'warn' : 'good'}>
                      Risk {member.riskScore}
                    </Chip>
                  ) : null}
                </div>
                <dl className="grid grid-cols-2 gap-px bg-line md:grid-cols-4">
                  <Fact label="Name" value={member.name} />
                  <Fact label="Member no." value={member.memberNo} />
                  <Fact label="Membership" value={member.membershipProduct ?? '—'} />
                  <Fact label="State" value={member.membershipState ?? '—'} />
                  <Fact label="Home branch" value={member.homeBranchName} />
                  <Fact
                    label="Last visit"
                    value={member.lastVisitAt ? dateTime(member.lastVisitAt, timeZone) : 'Never'}
                  />
                  <Fact
                    label="Balance"
                    // Null means the role may not see it, not zero.
                    value={member.balanceMinor === null ? null : money(member.balanceMinor)}
                  />
                  <Fact label="Other open tickets" value={String(Math.max(0, member.openTickets - 1))} />
                </dl>
              </section>
            ) : ticket.anonymous ? (
              <p className="border-b border-line bg-wash-sonar-soft px-3 py-2 text-[12px] leading-relaxed text-foam-80">
                Reported anonymously. Nothing links this to a person — no member id was recorded, so there is nothing
                to look up and nobody to reply to. Handle it on its own facts.
              </p>
            ) : null}

            {/* — The conversation. The same thread the member reads. — */}
            <section className="border-b border-line">
              <div className="flex items-center gap-2 px-3 py-2">
                <Label>Conversation</Label>
                <span className="flex-1" />
                <span className="font-utility text-[9px] uppercase tracking-[0.12em] text-foam-35">
                  {detail.data?.messages.length ?? 0} message
                  {(detail.data?.messages.length ?? 0) === 1 ? '' : 's'} · what the member sees
                </span>
              </div>
              {(detail.data?.messages.length ?? 0) === 0 ? (
                <p className="px-3 pb-3 text-[13px] text-foam-65">
                  No messages yet. {blocked ?? 'Your reply will appear in the member’s app.'}
                </p>
              ) : (
                <ul className="max-h-[320px] overflow-y-auto">
                  {(detail.data?.messages ?? []).map((m) => (
                    <li
                      key={m.id}
                      className={cx(
                        'border-t border-line-10 px-3 py-2',
                        m.fromMember ? 'bg-transparent' : 'bg-wash-sonar-soft',
                      )}
                    >
                      <div className="flex items-baseline gap-2">
                        <span className="font-utility text-[10px] font-semibold uppercase tracking-[0.12em] text-foam-45">
                          {m.fromMember ? m.senderName : `${m.senderName} · ${m.senderRole}`}
                        </span>
                        <span className="flex-1" />
                        {m.safetyFlagged ? <Chip tone="warn">Safety</Chip> : null}
                        <span className="text-[11px] text-foam-35" title={dateTime(m.at, timeZone)}>
                          {since(m.at)}
                        </span>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed">{m.body}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* — Reply. Blocked reasons are stated, not discovered. — */}
            <section className="border-b border-line p-3">
              <div className="flex items-center gap-2">
                <Label>{internal ? 'Internal note' : 'Reply to the member'}</Label>
                <span className="flex-1" />
                <Segmented
                  label="Reply visibility"
                  size="sm"
                  value={internal ? 'internal' : 'member'}
                  onChange={(v) => setInternal(v === 'internal')}
                  options={[
                    { value: 'member', label: 'To member' },
                    { value: 'internal', label: 'Internal' },
                  ]}
                />
              </div>

              {blocked && !internal ? (
                <p className="mt-2 border border-line bg-wash-flare px-2.5 py-2 text-[12px] leading-relaxed text-foam-80">
                  {blocked}
                </p>
              ) : (
                <>
                  <textarea
                    className="sf-field mt-2 !min-h-[84px] !text-[13px]"
                    aria-label={internal ? 'Internal note' : 'Reply to the member'}
                    placeholder={
                      internal
                        ? 'Notes for colleagues. The member never sees this.'
                        : 'This goes to the member’s app as a message.'
                    }
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                  />
                  <p className="mt-1.5 text-[11px] leading-relaxed text-foam-45">
                    {internal
                      ? 'Recorded on the ticket timeline only. It does not start or stop the reply clock.'
                      : ticket.sla.firstResponseAt
                        ? 'The reply clock already stopped when this ticket was first answered.'
                        : 'The first reply to the member is what the reply promise is measured against.'}
                  </p>
                  <Button
                    variant="cta"
                    full
                    className="mt-2"
                    disabled={!online || reply.trim().length === 0 || sendReply.isPending}
                    onClick={() => sendReply.mutate()}
                  >
                    {sendReply.isPending
                      ? 'Sending…'
                      : !online
                        ? 'Offline — cannot send'
                        : internal
                          ? 'Add internal note'
                          : 'Send to member'}
                  </Button>
                </>
              )}
            </section>

            {detail.data?.resolution ? (
              <p className="border-b border-line bg-wash-kelp px-3 py-2 text-[12px] leading-relaxed text-foam-80">
                Resolved: {detail.data.resolution}
              </p>
            ) : null}

            {/* — The permanent record (PF-SUP-006). — */}
            <section>
              <div className="flex items-center gap-2 px-3 py-2">
                <Label>History</Label>
                <span className="flex-1" />
                <span className="font-utility text-[9px] uppercase tracking-[0.12em] text-foam-35">
                  Append-only · cannot be edited
                </span>
              </div>
              <ol className="pb-2">
                {(detail.data?.timeline ?? []).map((event) => (
                  <li key={event.id} className="flex gap-2 border-t border-line-10 px-3 py-1.5 text-[12px]">
                    <span aria-hidden="true" className="mt-1.5 h-1 w-1 flex-none bg-sonar" />
                    <span className="min-w-0 flex-1 text-foam-80">{event.summary}</span>
                    <span className="whitespace-nowrap text-[11px] text-foam-35" title={dateTime(event.at, timeZone)}>
                      {since(event.at)}
                    </span>
                  </li>
                ))}
              </ol>
            </section>

            {error ? (
              <p role="alert" className="border-t border-line bg-wash-chum px-3 py-2 text-[12px] text-foam-80">
                {error}
              </p>
            ) : null}

            {!online ? (
              <p className="border-t border-line bg-wash-flare px-3 py-2 text-[12px] text-foam-80">
                Offline. Replies, assignment and resolution all need a connection.
              </p>
            ) : null}
          </>
        )}
      </Drawer>

      <ConfirmDialog
        open={resolveOpen}
        onClose={() => setResolveOpen(false)}
        onConfirm={() => act.mutate({ path: 'resolve', body: { resolution: resolution.trim() } })}
        tone="cta"
        title={`Resolve ${ticket?.reference ?? 'this ticket'}?`}
        consequence="The ticket moves to resolved and the resolution becomes part of its permanent record. The member can still reply, and you can reopen it if they do — resolving is not closing."
        confirmLabel="Resolve"
        reasonLabel="What was done"
        reason={resolution}
        onReasonChange={setResolution}
        pending={act.isPending}
        error={act.isError ? error : null}
      />

      <ConfirmDialog
        open={escalateOpen}
        onClose={() => setEscalateOpen(false)}
        onConfirm={() => act.mutate({ path: 'escalate', body: { reason: escalateReason.trim() } })}
        title={`Escalate ${ticket?.reference ?? 'this ticket'}?`}
        consequence="This raises an alert for the branch, lifts the priority, and writes an escalation record with your name and reason against it. Escalation cannot be undone — a dispute record that can be quietly lowered is not a record."
        confirmLabel="Escalate"
        reasonLabel="Why"
        reason={escalateReason}
        onReasonChange={setEscalateReason}
        pending={act.isPending}
        error={act.isError ? error : null}
      />

      <ConfirmDialog
        open={reopenOpen}
        onClose={() => setReopenOpen(false)}
        onConfirm={() => act.mutate({ path: 'reopen', body: { reason: reopenReason.trim() } })}
        tone="cta"
        title={`Reopen ${ticket?.reference ?? 'this ticket'}?`}
        consequence="It keeps its reference and its whole history, because it is the same issue coming back. The original reply time is not reset — the first answer still happened when it happened."
        confirmLabel="Reopen"
        reasonLabel="Why it is back"
        reason={reopenReason}
        onReasonChange={setReopenReason}
        pending={act.isPending}
        error={act.isError ? error : null}
      />
    </>
  );
}

function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="bg-panel px-3 py-2">
      <dt className="font-utility text-[9px] uppercase tracking-[0.14em] text-foam-45">{label}</dt>
      <dd className="mt-0.5 truncate text-[12px]">{value === null ? <Restricted /> : value}</dd>
    </div>
  );
}

function AssigneeSelect({
  value,
  disabled,
  onChange,
}: {
  value: string | null;
  disabled: boolean;
  onChange: (assigneeId: string | null) => void;
}) {
  const queue = useQuery({
    queryKey: ['support', 'assignees'],
    queryFn: () => api<{ assignees: Array<{ id: string; name: string }> }>('/admin/support/tickets?limit=1'),
    staleTime: 300_000,
  });

  return (
    <select
      aria-label="Ticket owner"
      className="min-h-9 w-full border border-line bg-panel px-2 text-[13px] text-foam disabled:opacity-40"
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">Unassigned</option>
      {(queue.data?.assignees ?? []).map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </select>
  );
}
