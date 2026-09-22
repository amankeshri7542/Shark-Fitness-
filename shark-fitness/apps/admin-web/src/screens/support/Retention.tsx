import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AtRiskMember, InterventionAction, RetentionView } from '@shark/contracts';
import { ApiError, OfflineError, api } from '../../lib/api';
import { useIdempotentAttempt } from '../../lib/idempotent-attempt';
import {
  Button,
  Chip,
  EmptyState,
  Label,
  Panel,
  Segmented,
  Skeleton,
  TD,
  TH,
  THead,
  TR,
  Table,
  TableScroll,
  Toolbar,
} from '../../ui/console';
import { Drawer } from '../../ui/overlay';
import { ACTION_LABEL, OUTCOME_LABEL, RiskChip, dayMonth, since } from './shared';

/* ============================================================================
   Retention risk and interventions (PF-SUP-003, PF-SUP-004, PF-SUP-005).

   A score with no explanation is a number staff will not act on, so every row
   carries the contributions that produced it and the action the engine
   suggests. Where the data is too thin or too distorted to score honestly —
   a member three weeks old, a month the branch spent shut — the row says so
   instead of reporting a confident zero.

   PF-SUP-005 lives on this screen as a refusal you can see: when an automated
   message may not be sent, the reason is printed next to the member rather
   than discovered by a pipeline that quietly drops them.
   ========================================================================= */

type Band = 'all' | 'high' | 'watch';

export default function Retention({
  data,
  loading,
  timeZone,
  online,
  onChanged,
}: {
  data: RetentionView | undefined;
  loading: boolean;
  timeZone: string;
  online: boolean;
  onChanged: () => void;
}) {
  const [band, setBand] = useState<Band>('all');
  const [target, setTarget] = useState<AtRiskMember | null>(null);
  const [closing, setClosing] = useState<string | null>(null);

  if (loading || !data) {
    return (
      <>
        <Toolbar>
          <Label>At risk</Label>
        </Toolbar>
        <Skeleton className="m-4 h-64" />
      </>
    );
  }

  const rows = data.atRisk.filter((m) => band === 'all' || m.band === band);
  const openWork = data.interventions.filter((i) => i.state === 'open');

  return (
    <>
      <Toolbar>
        <Label>Band</Label>
        <Segmented
          label="Risk band"
          value={band}
          onChange={setBand}
          options={[
            { value: 'all' as Band, label: 'All' },
            { value: 'high' as Band, label: 'High' },
            { value: 'watch' as Band, label: 'Watch' },
          ]}
        />
        <span className="flex-1" />
        <span className="font-utility text-[9px] uppercase tracking-[0.12em] text-foam-35">
          {data.bands.high} high · {data.bands.watch} watch · {data.bands.low} low
        </span>
      </Toolbar>

      <div className="grid gap-px bg-line xl:grid-cols-[1.4fr_1fr]">
        <Panel title={`At risk · ${rows.length}`}>
          {rows.length === 0 ? (
            <EmptyState
              title="Nobody in this band"
              body="Risk is recomputed from attendance, payments and membership every time this screen loads. An empty list here is good news, not missing data."
            />
          ) : (
            <TableScroll className="max-h-[calc(100vh-360px)]">
              <Table>
                <THead>
                  <TH>Member</TH>
                  <TH align="center">Risk</TH>
                  <TH>Why</TH>
                  <TH>Last visit</TH>
                  <TH align="right">Action</TH>
                </THead>
                <tbody>
                  {rows.map((m) => (
                    <TR key={m.memberId}>
                      <TD>
                        <div className="max-w-[22ch] truncate text-[13px]">{m.name}</div>
                        <div className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
                          {m.memberNo} · {m.branchName}
                        </div>
                      </TD>
                      <TD align="center">
                        <RiskChip band={m.band} score={m.score} />
                      </TD>
                      <TD>
                        {m.suppressed ? (
                          // Not scored, and it says why. PF-SUP-003's edge case
                          // is a gym closure inflating a score; here it simply
                          // stops the score being claimed at all.
                          <span className="text-[12px] italic text-foam-45">{m.suppressed}</span>
                        ) : (
                          <ul className="space-y-0.5">
                            {m.reasons.slice(0, 3).map((r) => (
                              <li key={r.code} className="flex items-baseline gap-1.5 text-[12px] text-foam-65">
                                <span className="font-utility text-[10px] tabular-nums text-flare">+{r.points}</span>
                                <span className="max-w-[30ch] truncate">{r.label}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                        {!m.outreach.allowed ? (
                          <div className="mt-1">
                            <Chip tone="warn">No automation · {m.outreach.reason}</Chip>
                          </div>
                        ) : null}
                      </TD>
                      <TD className="whitespace-nowrap text-[12px] text-foam-65">
                        {m.lastVisitAt ? since(m.lastVisitAt) : 'Never'}
                      </TD>
                      <TD align="right">
                        {m.openInterventionId ? (
                          <Chip tone="accent">Already assigned</Chip>
                        ) : (
                          <Button disabled={!online} onClick={() => setTarget(m)}>
                            Plan
                          </Button>
                        )}
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            </TableScroll>
          )}
        </Panel>

        <div className="flex min-w-0 flex-col gap-px bg-line">
          <Panel title={`Open interventions · ${openWork.length}`}>
            {openWork.length === 0 ? (
              <EmptyState title="No open work" body="Plan one from the list to give a member to somebody." />
            ) : (
              <ul>
                {openWork.map((i) => (
                  <li key={i.id} className="border-b border-line-10 px-3 py-2.5 last:border-b-0">
                    <div className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-[13px]">{i.memberName}</span>
                      {i.overdue ? <Chip tone="bad">Overdue</Chip> : null}
                    </div>
                    <div className="mt-0.5 font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
                      {ACTION_LABEL[i.action] ?? i.action} · {i.assigneeName ?? 'unassigned'} · due{' '}
                      {dayMonth(i.dueAt, timeZone)}
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-foam-45">
                      Raised at risk {i.riskScoreAtCreation}. {i.recommendedAction}
                    </p>
                    <Button className="mt-1.5" disabled={!online} onClick={() => setClosing(i.id)}>
                      Record outcome
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Does it work?">
            {data.effectiveness.length === 0 ? (
              <EmptyState title="Nothing measured yet" body="Outcomes recorded against interventions land here." />
            ) : (
              <TableScroll>
                <Table>
                  <THead>
                    <TH>Action</TH>
                    <TH align="right">Tried</TH>
                    <TH align="right">Stayed</TH>
                    <TH align="right">Left</TH>
                    <TH align="right">Kept</TH>
                  </THead>
                  <tbody>
                    {data.effectiveness.map((e) => (
                      <TR key={e.action}>
                        <TD className="text-[12px]">{ACTION_LABEL[e.action] ?? e.action}</TD>
                        <TD numeric>{e.attempted}</TD>
                        <TD numeric className="text-kelp">
                          {e.retained}
                        </TD>
                        <TD numeric className="text-chum">
                          {e.churned}
                        </TD>
                        <TD numeric>
                          {e.retentionRate === null ? (
                            // Under three judged cases. A rate over two is
                            // noise dressed as measurement.
                            <span className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
                              Too few
                            </span>
                          ) : (
                            `${e.retentionRate}%`
                          )}
                        </TD>
                      </TR>
                    ))}
                  </tbody>
                </Table>
              </TableScroll>
            )}
            <p className="border-t border-line px-3 py-2.5 text-[11px] leading-relaxed text-foam-45">
              Members nobody could reach, and those staff judged were never at risk, are left out of the rate rather
              than counted as failures — a call that went unanswered says nothing about whether calling works.
            </p>
          </Panel>
        </div>
      </div>

      {target ? (
        <PlanIntervention
          member={target}
          online={online}
          onClose={() => setTarget(null)}
          onSaved={() => {
            setTarget(null);
            onChanged();
          }}
        />
      ) : null}

      {closing ? (
        <RecordOutcome
          interventionId={closing}
          online={online}
          onClose={() => setClosing(null)}
          onSaved={() => {
            setClosing(null);
            onChanged();
          }}
        />
      ) : null}
    </>
  );
}

/* — Plan one ————————————————————————————————————————————————— */

function PlanIntervention({
  member,
  online,
  onClose,
  onSaved,
}: {
  member: AtRiskMember;
  online: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  // Pre-selected from the engine's own recommendation, but changeable — the
  // disagreement between what was suggested and what staff chose is the signal
  // effectiveness tracking is actually measuring.
  const [action, setAction] = useState<InterventionAction>(member.band === 'high' ? 'call' : 'coach_checkin');
  const [note, setNote] = useState('');
  const [dueInDays, setDueInDays] = useState(3);
  const [error, setError] = useState<string | null>(null);

  /* One intervention, one key. A duplicate here is not just a stray row: the
     member is assigned the same call twice, two staff can pick it up, and the
     effectiveness measure that compares recommended against chosen action is
     fed a repeat it should never have seen. */
  const attempt = useIdempotentAttempt('support-intervention', member.memberId);

  const save = useMutation({
    mutationFn: () => {
      const payload = { memberId: member.memberId, action, note: note.trim(), dueInDays };
      return api('/admin/support/interventions', {
        method: 'POST',
        idempotencyKey: attempt.keyFor(payload),
        body: payload,
      });
    },
    onSuccess: () => {
      attempt.retire();
      void queryClient.invalidateQueries({ queryKey: ['support'] });
      onSaved();
    },
    onError: (e) =>
      setError(
        e instanceof OfflineError
          ? 'No connection. If it was assigned, pressing again will not assign it twice.'
          : e instanceof ApiError
            ? e.message
            : 'That did not save.',
      ),
  });

  return (
    <Drawer
      open
      onClose={onClose}
      kicker={`${member.memberNo} · risk ${member.score}`}
      title={member.name}
      footer={
        <Button variant="cta" full disabled={!online || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : !online ? 'Offline' : 'Assign this'}
        </Button>
      }
    >
      <div className="border-b border-line bg-wash-sonar-soft px-3 py-2.5">
        <Label>Recommended</Label>
        <p className="mt-1 text-[13px] leading-relaxed">{member.recommendedAction}</p>
      </div>

      <section className="border-b border-line px-3 py-2.5">
        <Label>Why they are on this list</Label>
        <ul className="mt-1.5 space-y-1">
          {member.reasons.map((r) => (
            <li key={r.code} className="flex items-baseline justify-between gap-3 text-[13px]">
              <span className="min-w-0 flex-1">{r.label}</span>
              <span className="font-utility text-[11px] tabular-nums text-flare">+{r.points}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] leading-relaxed text-foam-45">
          Weeks the branch was closed are excluded before any of this is calculated, so a shutdown cannot push somebody
          onto this list.
        </p>
      </section>

      {!member.outreach.allowed ? (
        <p className="border-b border-line bg-wash-flare px-3 py-2 text-[12px] leading-relaxed text-foam-80">
          Automated messages are blocked for this member — {member.outreach.reason}. A person contacts them, or nobody
          does.
        </p>
      ) : null}

      <div className="border-b border-line p-3">
        <Label>What will be done</Label>
        <select
          aria-label="Intervention action"
          className="mt-1.5 min-h-9 w-full border border-line bg-panel px-2 text-[13px] text-foam"
          value={action}
          onChange={(e) => setAction(e.target.value as InterventionAction)}
        >
          {Object.entries(ACTION_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <div className="border-b border-line p-3">
        <Label>Due in</Label>
        <div className="mt-1.5 flex items-center gap-2">
          <input
            type="number"
            min={1}
            max={60}
            aria-label="Due in days"
            className="sf-field !min-h-9 !w-20 !text-right !text-[13px] tabular-nums"
            value={dueInDays}
            onChange={(e) => setDueInDays(Math.max(1, Math.min(60, Number.parseInt(e.target.value, 10) || 1)))}
          />
          <span className="text-[13px] text-foam-65">days</span>
        </div>
      </div>

      <div className="border-b border-line p-3">
        <Label>Note</Label>
        <textarea
          className="sf-field mt-1.5 !min-h-[70px] !text-[13px]"
          aria-label="Intervention note"
          placeholder="Anything the person making contact should know first."
          value={note}
          onChange={(e) => setNote(e.target.value)}
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

/* — Close one out ———————————————————————————————————————————— */

function RecordOutcome({
  interventionId,
  online,
  onClose,
  onSaved,
}: {
  interventionId: string;
  online: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState('retained');
  const [outcomeNote, setOutcomeNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api(`/admin/support/interventions/${interventionId}/close`, {
        method: 'POST',
        body: {
          outcome,
          outcomeNote: outcomeNote.trim(),
          state: outcome === 'false_positive' ? 'dismissed' : 'done',
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['support'] });
      onSaved();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'That did not save.'),
  });

  return (
    <Drawer
      open
      onClose={onClose}
      kicker="Intervention"
      title="What happened?"
      footer={
        <Button variant="cta" full disabled={!online || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : !online ? 'Offline' : 'Record it'}
        </Button>
      }
    >
      <div className="border-b border-line p-3">
        <Label>Outcome</Label>
        <div className="mt-1.5 flex flex-col gap-1.5">
          {Object.entries(OUTCOME_LABEL).map(([value, label]) => (
            <label key={value} className="flex items-start gap-2 text-[13px]">
              <input
                type="radio"
                name="outcome"
                className="mt-1"
                value={value}
                checked={outcome === value}
                onChange={() => setOutcome(value)}
              />
              <span>
                {label}
                {value === 'no_contact' ? (
                  <span className="mt-0.5 block text-[11px] text-foam-45">
                    Left out of the effectiveness rate — it tested nothing.
                  </span>
                ) : null}
                {value === 'false_positive' ? (
                  <span className="mt-0.5 block text-[11px] text-foam-45">
                    Says the score was wrong. Also excluded from the rate, and counted separately so a rising number
                    is visible.
                  </span>
                ) : null}
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="border-b border-line p-3">
        <Label>Note</Label>
        <textarea
          className="sf-field mt-1.5 !min-h-[70px] !text-[13px]"
          aria-label="Outcome note"
          value={outcomeNote}
          onChange={(e) => setOutcomeNote(e.target.value)}
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
