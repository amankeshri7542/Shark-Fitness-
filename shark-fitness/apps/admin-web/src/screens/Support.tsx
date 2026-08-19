import { useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FeedbackSummary, RetentionView, TicketCategory, TicketQueue } from '@shark/contracts';
import { ApiError, api, idempotencyKey } from '../lib/api';
import { useBranchScope, useBranchTimeZone, usePermission } from '../lib/store';
import { useOnline } from '../lib/realtime';
import { Page } from '../ui/shell';
import { Button, Chip, ErrorState, Label, Panel, PermissionState, Tabs } from '../ui/console';
import { Drawer } from '../ui/overlay';
import Queue from './support/Queue';
import Feedback from './support/Feedback';
import Retention from './support/Retention';
import TicketDrawer from './support/TicketDrawer';
import { CATEGORY_LABEL } from './support/shared';

/* ============================================================================
   Support — tickets, feedback and retention (PF-SUP).

   Three surfaces, because the module answers three different questions that
   happen at different rhythms: *who is waiting on us right now* (the queue,
   worked continuously), *how are we doing* (feedback, read weekly), and *who
   is about to leave* (retention, acted on in batches).

   Support is a plain-register surface. Nothing here reaches for the training
   floor's voice: somebody writing to a support desk is usually annoyed,
   occasionally frightened, and sometimes reporting something serious.

   Which surface is open lives in the URL, and so does an open ticket — a
   breach alert links straight to `?tab=queue&ticket=…` rather than to a screen
   somebody then has to search.

   Feedback and retention load only when opened. The retention read recomputes
   risk over the check-in, payment and membership history of every member in
   scope; running that to show somebody a ticket queue would be the most
   expensive thing this console does, for nothing.
   ========================================================================= */

type Section = 'queue' | 'feedback' | 'retention';
type Flag = 'all' | 'mine' | 'unassigned' | 'breached' | 'escalated';

interface SurfaceFailure {
  title: string;
  body: string;
  failed: boolean;
  retry: () => void;
}

export default function SupportScreen() {
  const canManage = usePermission('support.manage');
  const { branchId, branchName } = useBranchScope();
  const timeZone = useBranchTimeZone();
  const online = useOnline();
  const queryClient = useQueryClient();

  const { tab: section, ticket: openTicketId } = useSearch({ from: '/console/support' });
  const navigate = useNavigate({ from: '/support' });
  const setSection = (next: Section): void => {
    void navigate({ search: () => ({ tab: next }), replace: true });
  };
  const setOpenTicket = (ticketId: string | null): void => {
    void navigate({
      search: (prev) => ({ ...prev, ...(ticketId ? { ticket: ticketId } : { ticket: undefined }) }),
      replace: true,
    });
  };

  const [flag, setFlag] = useState<Flag>('all');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);

  const scope = new URLSearchParams();
  if (branchId) scope.set('branchId', branchId);
  if (flag !== 'all') scope.set('flag', flag);
  if (search.trim()) scope.set('q', search.trim());
  const queueQuery = scope.toString();

  const tickets = useQuery({
    queryKey: ['support', 'tickets', branchId, flag, search.trim()],
    queryFn: () => api<TicketQueue>(`/admin/support/tickets${queueQuery ? `?${queueQuery}` : ''}`),
    enabled: canManage,
  });

  const feedback = useQuery({
    queryKey: ['support', 'feedback', branchId],
    queryFn: () => api<FeedbackSummary>(`/admin/support/feedback${branchId ? `?branchId=${branchId}` : ''}`),
    enabled: canManage && section === 'feedback',
  });

  const retention = useQuery({
    queryKey: ['support', 'retention', branchId],
    queryFn: () => api<RetentionView>(`/admin/support/retention${branchId ? `?branchId=${branchId}` : ''}`),
    enabled: canManage && section === 'retention',
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['support'] });
  };

  /* A failed read is not an empty desk. "Nothing in the queue" on a morning
     with nine breaching tickets is the most damaging thing this screen could
     say, so each surface names the read it cannot work without. */
  const failures: Record<Section, SurfaceFailure> = {
    queue: {
      title: 'Could not load the queue',
      body: 'The API did not answer. This is not an empty desk — there may well be tickets waiting that could not be read.',
      failed: tickets.isError,
      retry: () => void tickets.refetch(),
    },
    feedback: {
      title: 'Could not load feedback',
      body: 'The API did not answer. Nothing here is a zero score — the responses could not be read at all.',
      failed: feedback.isError,
      retry: () => void feedback.refetch(),
    },
    retention: {
      title: 'Could not work out who is at risk',
      body: 'The API did not answer. An empty list would mean nobody is at risk, which is not what happened.',
      failed: retention.isError,
      retry: () => void retention.refetch(),
    },
  };

  // Hooks all run above the gate, so the count never changes when the
  // permission resolves.
  if (!canManage) {
    return (
      <Page title="Support">
        <PermissionState what="The support desk" />
      </Page>
    );
  }

  const counts = tickets.data?.counts;
  const failure = failures[section];

  const sections = [
    {
      key: 'queue',
      label: 'Queue',
      ...(counts && counts.breached > 0 ? { hint: String(counts.breached) } : {}),
    },
    { key: 'feedback', label: 'Feedback' },
    {
      key: 'retention',
      label: 'Retention',
      ...(retention.data && retention.data.bands.high > 0 ? { hint: String(retention.data.bands.high) } : {}),
    },
  ];

  return (
    <Page
      title="Support"
      kicker={branchName}
      actions={
        <div className="flex items-center gap-2">
          {counts && counts.breached > 0 ? <Chip tone="bad">{counts.breached} past the promise</Chip> : null}
          {!online ? <Chip tone="bad">Offline</Chip> : null}
        </div>
      }
    >
      <Tabs
        label="Support sections"
        items={sections}
        active={section}
        onChange={(key) => setSection(key as Section)}
      />

      {!online ? (
        <Panel tone="warn" className="p-3">
          <p className="text-[13px] text-foam-80">
            Offline. Nothing here will save and no reply will reach a member — what is on screen is the last state this
            machine saw.
          </p>
        </Panel>
      ) : null}

      <div
        role="tabpanel"
        id={`panel-${section}`}
        aria-labelledby={`tab-${section}`}
        className="flex min-h-0 flex-col"
      >
        {failure.failed ? (
          <ErrorState title={failure.title} body={failure.body} onRetry={failure.retry} />
        ) : (
          <>
            {section === 'queue' ? (
              <Queue
                data={tickets.data}
                loading={tickets.isPending}
                timeZone={timeZone}
                online={online}
                canManage={canManage}
                flag={flag}
                onFlag={setFlag}
                search={search}
                onSearch={setSearch}
                onOpen={setOpenTicket}
                onNew={() => setCreating(true)}
              />
            ) : null}

            {section === 'feedback' ? (
              <Feedback
                data={feedback.data}
                loading={feedback.isPending}
                timeZone={timeZone}
                online={online}
                onChanged={refresh}
              />
            ) : null}

            {section === 'retention' ? (
              <Retention
                data={retention.data}
                loading={retention.isPending}
                timeZone={timeZone}
                online={online}
                onChanged={refresh}
              />
            ) : null}
          </>
        )}
      </div>

      {openTicketId ? (
        <TicketDrawer
          ticketId={openTicketId}
          timeZone={timeZone}
          online={online}
          onClose={() => setOpenTicket(null)}
          onChanged={refresh}
        />
      ) : null}

      {creating ? (
        <NewTicket
          branchId={branchId}
          online={online}
          categories={tickets.data?.categories ?? []}
          onClose={() => setCreating(false)}
          onCreated={(ticketId) => {
            setCreating(false);
            refresh();
            setOpenTicket(ticketId);
          }}
        />
      ) : null}
    </Page>
  );
}

/* — Raise one at the desk ————————————————————————————————————— */

function NewTicket({
  branchId,
  online,
  categories,
  onClose,
  onCreated,
}: {
  branchId: string | null;
  online: boolean;
  categories: Array<{ value: TicketCategory; responseMinutes: number }>;
  onClose: () => void;
  onCreated: (ticketId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [category, setCategory] = useState<TicketCategory>('other');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [memberQuery, setMemberQuery] = useState('');
  const [member, setMember] = useState<{ id: string; name: string; memberNo: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hits = useQuery({
    queryKey: ['support', 'member-lookup', memberQuery.trim()],
    queryFn: () =>
      api<{ items: Array<{ id: string; name: string; memberNo: string }> }>(
        `/admin/members?q=${encodeURIComponent(memberQuery.trim())}&limit=6`,
      ),
    enabled: memberQuery.trim().length >= 2,
    staleTime: 30_000,
  });

  const create = useMutation({
    mutationFn: () =>
      api<{ ticket: { id: string } }>('/admin/support/tickets', {
        method: 'POST',
        idempotencyKey: idempotencyKey('support-ticket', subject.trim().slice(0, 40)),
        body: {
          memberId: member?.id ?? null,
          branchId,
          category,
          subject: subject.trim(),
          body: body.trim(),
        },
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['support'] });
      onCreated(result.ticket.id);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'The ticket did not save.'),
  });

  const promise = categories.find((c) => c.value === category);
  const ready = subject.trim().length >= 3 && body.trim().length > 0;

  return (
    <Drawer
      open
      onClose={onClose}
      kicker="Support"
      title="New ticket"
      footer={
        <Button variant="cta" full disabled={!ready || !online || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? 'Raising…' : !online ? 'Offline' : 'Raise ticket'}
        </Button>
      }
    >
      <div className="border-b border-line p-3">
        <Label>Category</Label>
        <select
          aria-label="Ticket category"
          className="mt-1.5 min-h-9 w-full border border-line bg-panel px-2 text-[13px] text-foam"
          value={category}
          onChange={(e) => setCategory(e.target.value as TicketCategory)}
        >
          {Object.entries(CATEGORY_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        {promise ? (
          <p className="mt-1.5 text-[11px] leading-relaxed text-foam-45">
            Promises a first reply within {Math.round(promise.responseMinutes / 60)} hours of opening time — the clock
            pauses while the branch is shut.
          </p>
        ) : null}
      </div>

      <div className="border-b border-line p-3">
        <Label>Member (optional)</Label>
        {member ? (
          <div className="mt-1.5 flex items-center gap-2 border border-line px-2.5 py-2">
            <span className="min-w-0 flex-1 truncate text-[13px]">{member.name}</span>
            <span className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
              {member.memberNo}
            </span>
            <Button variant="ghost" onClick={() => setMember(null)}>
              Remove
            </Button>
          </div>
        ) : (
          <>
            <input
              className="sf-field mt-1.5 !min-h-9 !text-[13px]"
              aria-label="Find a member"
              placeholder="Name, number or phone — leave blank for a walk-in"
              value={memberQuery}
              onChange={(e) => setMemberQuery(e.target.value)}
            />
            {memberQuery.trim().length >= 2 ? (
              <ul className="mt-1.5 border border-line">
                {(hits.data?.items ?? []).length === 0 ? (
                  <li className="px-2.5 py-2 text-[12px] text-foam-45">
                    {hits.isFetching ? 'Looking…' : 'No member matches. A ticket without one is fine.'}
                  </li>
                ) : (
                  (hits.data?.items ?? []).map((hit) => (
                    <li key={hit.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setMember(hit);
                          setMemberQuery('');
                        }}
                        className="flex w-full cursor-pointer items-center justify-between gap-2 border-b border-line-10 px-2.5 py-1.5 text-left text-[12px] last:border-b-0 hover:bg-wash-sonar"
                      >
                        <span className="truncate">{hit.name}</span>
                        <span className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
                          {hit.memberNo}
                        </span>
                      </button>
                    </li>
                  ))
                )}
              </ul>
            ) : null}
            <p className="mt-1.5 text-[11px] leading-relaxed text-foam-45">
              With a member attached, the ticket gets a conversation they can see and answer in the app. Without one it
              stays a desk record.
            </p>
          </>
        )}
      </div>

      <div className="border-b border-line p-3">
        <Label>Subject</Label>
        <input
          className="sf-field mt-1.5 !min-h-9 !text-[13px]"
          aria-label="Subject"
          placeholder="One line — what is wrong"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
      </div>

      <div className="border-b border-line p-3">
        <Label>What happened</Label>
        <textarea
          className="sf-field mt-1.5 !min-h-[100px] !text-[13px]"
          aria-label="What happened"
          placeholder="In the member's words where you can. This becomes the first message they see."
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </div>

      {error ? (
        <p role="alert" className="border-t border-line bg-wash-chum px-3 py-2 text-[12px] text-foam-80">
          {error}
        </p>
      ) : null}
    </Drawer>
  );
}
