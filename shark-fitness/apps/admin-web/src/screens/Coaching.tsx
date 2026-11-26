import { useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, OfflineError, api } from '../lib/api';
import { useBranchScope, usePermission } from '../lib/store';
import { useOnline } from '../lib/realtime';
import { Page } from '../ui/shell';
import { Button, Chip, EmptyState, ErrorState, Label, Panel, PermissionState, Skeleton, TextAreaField, cx } from '../ui/console';

/* ============================================================================
   Nutrition & Habits — the coach's view (P07; PF-NUTR-002/003).

   Who needs me this week: members with a flagged check-in first (a safety
   phrase routed it to a person), then check-ins waiting for a reply. A
   trainer sees only their own members. A flagged check-in is answered by a
   person, in plain words — the screen says so rather than offering advice.
   ========================================================================= */

export interface RosterItem {
  memberId: string;
  name: string;
  initials: string;
  memberNo: string;
  habits: number;
  adherence7: number | null;
  lastCheckIn: { weekStart: string; submittedRelative: string; replied: boolean } | null;
  awaitingReply: number;
  flagged: boolean;
}

export interface CoachDetail {
  member: { id: string; name: string; memberNo: string };
  habits: Array<{
    id: string;
    name: string;
    target: number;
    unit: string;
    adherence7: number | null;
    adherence28: number | null;
    week: Array<{ date: string; value: number | null; met: boolean }>;
  }>;
  adherence7: number | null;
  checkIns: Array<{
    id: string;
    weekStart: string;
    submitted: boolean;
    submittedRelative: string | null;
    scores: Record<string, number | null>;
    note: string;
    coachReply: string | null;
    coachReplyByName: string | null;
    safetyEscalated: boolean;
    safetySignals: string[];
  }>;
  templates: Array<{ key: string; name: string; why: string; assigned: boolean }>;
}

const SCORE_LABEL: Record<string, string> = {
  adherence: 'Plan',
  energy: 'Energy',
  hunger: 'Hunger',
  sleep: 'Sleep',
  soreness: 'Soreness',
  mood: 'Mood',
};

function failure(error: unknown, fallback: string): string {
  if (error instanceof OfflineError) return 'No connection. Nothing was saved.';
  if (error instanceof ApiError) return error.message;
  return fallback;
}

export default function CoachingScreen() {
  const canCoach = usePermission('training.assign');
  const { branchId, branchName } = useBranchScope();
  const online = useOnline();
  const search = useSearch({ strict: false }) as { member?: string };
  const navigate = useNavigate();
  const selected = search.member ?? null;

  const roster = useQuery({
    queryKey: ['coaching', 'roster', branchId],
    queryFn: () => api<{ items: RosterItem[]; counts: { flagged: number; awaitingReply: number } }>('/admin/coaching/members'),
    enabled: canCoach,
  });

  if (!canCoach) {
    return (
      <Page title="Nutrition & Habits">
        <PermissionState what="Coaching" />
      </Page>
    );
  }

  return (
    <Page
      title="Nutrition & Habits"
      kicker={branchName}
      actions={
        <div className="flex items-center gap-2">
          {roster.data && roster.data.counts.flagged > 0 ? <Chip tone="bad">{roster.data.counts.flagged} need a person</Chip> : null}
          {roster.data && roster.data.counts.awaitingReply > 0 ? <Chip tone="warn">{roster.data.counts.awaitingReply} check-ins to answer</Chip> : null}
          {!online ? <Chip tone="bad">Offline</Chip> : null}
        </div>
      }
    >
      {!online ? (
        <Panel tone="warn" className="p-3">
          <p className="text-[13px] text-foam-80">Offline. Replies and new habits will not save until the connection is back.</p>
        </Panel>
      ) : null}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(260px,340px)_1fr]">
        <section aria-label="Your members" className="min-h-0 overflow-y-auto border-r border-line">
          {roster.isPending ? (
            <div className="flex flex-col gap-2 p-3" aria-label="Loading members">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="h-14" />
              ))}
            </div>
          ) : roster.isError ? (
            <ErrorState title="Could not load your members" body="Try again in a moment." onRetry={() => void roster.refetch()} />
          ) : roster.data.items.length === 0 ? (
            <EmptyState
              title="No members to coach yet"
              body="Members assigned to you appear here. Members who switched nutrition and recovery off are not shown."
            />
          ) : (
            <ul>
              {roster.data.items.map((m) => (
                <li key={m.memberId}>
                  <button
                    type="button"
                    aria-current={selected === m.memberId ? 'true' : undefined}
                    onClick={() => void navigate({ to: '/coaching', search: { member: m.memberId }, replace: true })}
                    className={cx(
                      'flex w-full flex-col gap-1 border-b border-line-10 px-3.5 py-3 text-left hover:bg-wash-sonar-soft',
                      selected === m.memberId && 'bg-wash-sonar',
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <span className="truncate text-[13px] text-foam">{m.name}</span>
                      <span className="flex-1" />
                      {m.adherence7 !== null ? <span className="text-[12px] text-foam-65">{m.adherence7}% this week</span> : null}
                    </span>
                    <span className="flex flex-wrap gap-1.5">
                      {m.flagged ? <Chip tone="bad">Needs a person</Chip> : null}
                      {m.awaitingReply > 0 && !m.flagged ? <Chip tone="warn">Check-in to answer</Chip> : null}
                      <span className="text-[11px] text-foam-50">
                        {m.lastCheckIn ? `Last check-in ${m.lastCheckIn.submittedRelative}` : 'No check-in yet'}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-label="Member coaching" className="min-h-0 overflow-y-auto">
          {selected ? (
            <MemberCoaching key={selected} memberId={selected} online={online} />
          ) : (
            <EmptyState title="Choose a member" body="See their habits this week, read their check-ins and reply." />
          )}
        </section>
      </div>
    </Page>
  );
}

function MemberCoaching({ memberId, online }: { memberId: string; online: boolean }) {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ['coaching', 'member', memberId],
    queryFn: () => api<CoachDetail>(`/admin/coaching/members/${memberId}`),
  });
  const refresh = (): void => void queryClient.invalidateQueries({ queryKey: ['coaching'] });
  const assign = useMutation({
    mutationFn: (templateKey: string) => api(`/admin/coaching/members/${memberId}/habits`, { method: 'POST', body: { templateKey } }),
    onSuccess: refresh,
  });

  if (detail.isPending) return <Skeleton className="m-4 h-64" />;
  if (detail.isError) {
    return (
      <ErrorState
        title="Could not open this member"
        body={detail.error instanceof ApiError && detail.error.status === 404 ? 'They are not one of your members, or they switched nutrition and recovery off.' : 'Try again.'}
        onRetry={() => void detail.refetch()}
      />
    );
  }
  const d = detail.data;

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <Label>{d.member.memberNo}</Label>
        <h2 className="text-[18px] text-foam">{d.member.name}</h2>
        <p className="text-[12px] text-foam-65">{d.adherence7 !== null ? `Habits met ${d.adherence7}% of the last 7 days` : 'No daily habits yet'}</p>
      </div>

      <section aria-label="Habits">
        <Label>Habits</Label>
        {d.habits.length === 0 ? (
          <p className="mt-1 text-[13px] text-foam-65">No habits yet. Add one below.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {d.habits.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-3 border border-line px-3 py-2">
                <span className="min-w-[160px] flex-1 text-[13px]">
                  {h.name}
                  <span className="block text-[11px] text-foam-50">
                    {h.target} {h.unit} · {h.adherence28 ?? 0}% over 4 weeks
                  </span>
                </span>
                <span className="flex gap-1" aria-label={`Last 7 days: ${h.week.filter((w) => w.met).length} of 7 met`}>
                  {h.week.map((day) => (
                    <span
                      key={day.date}
                      title={`${day.date}: ${day.value ?? 'nothing logged'}`}
                      className={cx('h-4 w-4 border', day.met ? 'border-kelp bg-kelp' : day.value !== null ? 'border-flare' : 'border-line-strong')}
                    />
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {d.templates
            .filter((t) => !t.assigned)
            .map((t) => (
              <Button key={t.key} variant="outline" disabled={!online} pending={assign.isPending && assign.variables === t.key} title={t.why} onClick={() => assign.mutate(t.key)}>
                + {t.name}
              </Button>
            ))}
        </div>
        {assign.isError ? <p role="alert" className="mt-1 text-[12px] text-chum">{failure(assign.error, 'The habit was not added.')}</p> : null}
      </section>

      <section aria-label="Weekly check-ins" className="flex flex-col gap-3">
        <Label>Weekly check-ins</Label>
        {d.checkIns.filter((c) => c.submitted).length === 0 ? (
          <p className="text-[13px] text-foam-65">No check-ins yet.</p>
        ) : (
          d.checkIns
            .filter((c) => c.submitted)
            .map((c) => <CheckInCard key={c.id} checkIn={c} online={online} onReplied={refresh} />)
        )}
      </section>
    </div>
  );
}

function CheckInCard({ checkIn, online, onReplied }: { checkIn: CoachDetail['checkIns'][number]; online: boolean; onReplied: () => void }) {
  const [reply, setReply] = useState('');
  const send = useMutation({
    mutationFn: () => api(`/admin/coaching/check-ins/${checkIn.id}/reply`, { method: 'POST', body: { reply: reply.trim() } }),
    onSuccess: () => {
      setReply('');
      onReplied();
    },
  });
  return (
    <Panel tone={checkIn.safetyEscalated && !checkIn.coachReply ? 'warn' : 'plain'} className="flex flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px]">Week of {checkIn.weekStart}</span>
        <span className="text-[11px] text-foam-50">{checkIn.submittedRelative}</span>
        <span className="flex-1" />
        {checkIn.safetyEscalated ? <Chip tone="bad">Flagged for a person</Chip> : null}
      </div>
      {checkIn.safetyEscalated && !checkIn.coachReply ? (
        <p className="text-[12px] leading-relaxed text-foam-80">
          Something in this check-in was routed to you to read. Nothing automatic answered it. Talk to them in person or
          reply here; if it sounds medical, point them to a doctor rather than giving advice.
        </p>
      ) : null}
      <dl className="grid grid-cols-3 gap-x-3 gap-y-1 sm:grid-cols-6">
        {Object.entries(checkIn.scores).map(([key, value]) => (
          <div key={key}>
            <dt className="text-[10px] uppercase tracking-[0.1em] text-foam-50">{SCORE_LABEL[key] ?? key}</dt>
            <dd className="text-[14px]">{value ?? '–'}/5</dd>
          </div>
        ))}
      </dl>
      {checkIn.note ? <p className="whitespace-pre-wrap border-l-2 border-line-strong pl-2.5 text-[13px] leading-relaxed">{checkIn.note}</p> : null}
      {checkIn.coachReply ? (
        <p className="text-[13px] text-foam-80">
          <span className="text-foam-50">{checkIn.coachReplyByName ?? 'Coach'} replied: </span>
          {checkIn.coachReply}
        </p>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (reply.trim().length >= 2) send.mutate();
          }}
        >
          <TextAreaField label="Reply" rows={2} maxLength={2000} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="The member sees this in the app." />
          {send.isError ? <p role="alert" className="text-[12px] text-chum">{failure(send.error, 'The reply did not send.')}</p> : null}
          <Button type="submit" variant="cta" disabled={!online || reply.trim().length < 2} pending={send.isPending} pendingLabel="Sending">
            Send reply
          </Button>
        </form>
      )}
    </Panel>
  );
}
