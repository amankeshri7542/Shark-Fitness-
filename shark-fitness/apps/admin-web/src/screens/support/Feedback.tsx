import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { FeedbackSummary } from '@shark/contracts';
import { ApiError, OfflineError, api } from '../../lib/api';
import { useIdempotentAttempt } from '../../lib/idempotent-attempt';
import {
  Button,
  Chip,
  EmptyState,
  Label,
  Metric,
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
import { dayMonth } from './shared';

/* ============================================================================
   Feedback (PF-SUP-002).

   NPS, CSAT, class and trainer ratings and cancellation reasons in one place,
   because they are one question asked five ways and splitting them would make
   "how is this branch doing" a five-tab answer.

   Every derived figure is withheld under its reporting floor rather than
   printed from two responses. An NPS of −100 from a single grumpy answer is
   arithmetically true, completely useless, and invites a decision nobody
   should make (PF-RPT-004: label model-derived and incomplete values).
   ========================================================================= */

type Kind = 'all' | 'nps' | 'csat' | 'class' | 'trainer' | 'cancellation';

const KIND_LABEL: Record<string, string> = {
  nps: 'NPS',
  csat: 'CSAT',
  class: 'Class',
  trainer: 'Trainer',
  facility: 'Facility',
  cancellation: 'Cancellation',
};

export default function Feedback({
  data,
  loading,
  timeZone,
  online,
  onChanged,
}: {
  data: FeedbackSummary | undefined;
  loading: boolean;
  timeZone: string;
  online: boolean;
  onChanged: () => void;
}) {
  const [kind, setKind] = useState<Kind>('all');
  const [recording, setRecording] = useState(false);

  if (loading || !data) {
    return (
      <>
        <Toolbar>
          <Label>Feedback</Label>
        </Toolbar>
        <Skeleton className="m-4 h-64" />
      </>
    );
  }

  const rows = data.items.filter((f) => kind === 'all' || f.kind === kind);

  return (
    <>
      <Toolbar>
        <Label>Show</Label>
        <Segmented
          label="Feedback kind"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'all' as Kind, label: 'All' },
            { value: 'nps' as Kind, label: 'NPS' },
            { value: 'csat' as Kind, label: 'CSAT' },
            { value: 'class' as Kind, label: 'Class' },
            { value: 'trainer' as Kind, label: 'Trainer' },
            { value: 'cancellation' as Kind, label: 'Leaving' },
          ]}
        />
        <span className="flex-1" />
        <span className="font-utility text-[9px] uppercase tracking-[0.12em] text-foam-35">
          {data.anonymousCount} given anonymously
        </span>
        <Button variant="cta" disabled={!online} onClick={() => setRecording(true)}>
          {online ? 'Record feedback' : 'Offline'}
        </Button>
      </Toolbar>

      <div className="grid grid-cols-2 gap-px bg-line md:grid-cols-4">
        <Cell
          label="NPS"
          value={data.nps.score === null ? null : String(data.nps.score)}
          unit={`${data.nps.responses} response${data.nps.responses === 1 ? '' : 's'}`}
          floorNote="Needs 5 responses"
          tone={data.nps.score !== null && data.nps.score >= 30 ? 'good' : 'default'}
        />
        <Cell
          label="CSAT"
          value={data.csat.average === null ? null : data.csat.average.toFixed(1)}
          unit={data.csat.satisfiedPct === null ? `${data.csat.responses} responses` : `${data.csat.satisfiedPct}% happy`}
          floorNote="Needs 5 responses"
        />
        <Cell
          label="Class rating"
          value={data.classRating === null ? null : data.classRating.toFixed(1)}
          unit="out of 5"
          floorNote="Needs 5 ratings"
        />
        <Cell
          label="Trainer rating"
          value={data.trainerRating === null ? null : data.trainerRating.toFixed(1)}
          unit="out of 5"
          floorNote="Needs 5 ratings"
        />
      </div>

      <div className="grid gap-px bg-line lg:grid-cols-[1fr_360px]">
        <Panel title={`Responses · ${rows.length}`}>
          {rows.length === 0 ? (
            <EmptyState
              title="Nothing here yet"
              body="Feedback arrives from post-class prompts, NPS surveys and cancellations. You can also record one taken at the desk."
            />
          ) : (
            <TableScroll className="max-h-[calc(100vh-420px)]">
              <Table>
                <THead>
                  <TH>Kind</TH>
                  <TH align="right">Score</TH>
                  <TH>Comment</TH>
                  <TH>From</TH>
                  <TH>About</TH>
                  <TH>When</TH>
                </THead>
                <tbody>
                  {rows.map((f) => (
                    <TR key={f.id}>
                      <TD className="whitespace-nowrap text-[12px]">{KIND_LABEL[f.kind] ?? f.kind}</TD>
                      <TD numeric>
                        {f.score === null ? (
                          <span className="text-foam-35">—</span>
                        ) : (
                          <span
                            className={
                              f.kind === 'nps'
                                ? f.score >= 9
                                  ? 'text-kelp'
                                  : f.score <= 6
                                    ? 'text-chum'
                                    : undefined
                                : f.score <= 2
                                  ? 'text-chum'
                                  : undefined
                            }
                          >
                            {f.score}
                          </span>
                        )}
                      </TD>
                      <TD>
                        <div className="max-w-[40ch] truncate text-[12px] text-foam-65">{f.comment || '—'}</div>
                      </TD>
                      <TD className="text-[12px] text-foam-65">
                        {f.anonymous ? (
                          <Chip tone="neutral" glyph={false}>
                            Anonymous
                          </Chip>
                        ) : (
                          (f.memberName ?? '—')
                        )}
                      </TD>
                      <TD className="text-[12px] text-foam-45">{f.subjectLabel ?? '—'}</TD>
                      <TD className="whitespace-nowrap text-[12px] text-foam-45">{dayMonth(f.at, timeZone)}</TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            </TableScroll>
          )}
        </Panel>

        <Panel title="Why people leave">
          {data.cancellationReasons.length === 0 ? (
            <EmptyState title="No cancellations recorded" body="Reasons captured at cancellation collect here." />
          ) : (
            <ul className="p-3">
              {data.cancellationReasons.map((r) => (
                <li key={r.reason} className="mb-2 last:mb-0">
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13px]">{r.reason}</span>
                    <span className="font-display text-[15px] tabular-nums">{r.count}</span>
                  </div>
                  <div className="mt-1 h-1 w-full bg-[var(--sf-data-track)]">
                    <div
                      className="h-full bg-flare"
                      style={{
                        width: `${Math.round((r.count / (data.cancellationReasons[0]?.count ?? 1)) * 100)}%`,
                      }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="border-t border-line px-3 py-2.5 text-[11px] leading-relaxed text-foam-45">
            The one report on this screen that changes what the gym does next quarter, rather than how it feels about
            last one.
          </p>
        </Panel>
      </div>

      {recording ? (
        <RecordFeedback online={online} onClose={() => setRecording(false)} onSaved={onChanged} />
      ) : null}
    </>
  );
}

function Cell({
  label,
  value,
  unit,
  floorNote,
  tone = 'default',
}: {
  label: string;
  value: string | null;
  unit?: string;
  floorNote: string;
  tone?: 'default' | 'good';
}) {
  return (
    <div className="bg-panel p-3">
      <Label>{label}</Label>
      <div className="mt-1">
        {value === null ? (
          // Not enough responses to divide by. Stated, not printed as zero.
          <span className="font-utility text-[11px] uppercase tracking-[0.12em] text-foam-35">
            Not enough yet
            <span className="ml-1.5 normal-case text-foam-50">· {floorNote}</span>
          </span>
        ) : (
          <Metric value={value} unit={unit} tone={tone === 'good' ? 'good' : 'default'} />
        )}
      </div>
    </div>
  );
}

/* — Record one taken at the desk ————————————————————————————— */

function RecordFeedback({
  online,
  onClose,
  onSaved,
}: {
  online: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState('csat');
  const [score, setScore] = useState('');
  const [comment, setComment] = useState('');
  const [anonymous, setAnonymous] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* One response, one key. Feedback is what the satisfaction figures are
     computed from, so a retry that recorded a second copy would quietly weight
     one member's answer twice in every CSAT and NPS number after it. */
  const attempt = useIdempotentAttempt('support-feedback');

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        kind,
        score: score === '' ? null : Number.parseInt(score, 10),
        comment: comment.trim(),
        anonymous,
        memberId: null,
      };
      return api('/admin/support/feedback', {
        method: 'POST',
        idempotencyKey: attempt.keyFor(payload),
        body: payload,
      });
    },
    onSuccess: () => {
      // Two members can genuinely give the same score with no comment, and the
      // second one must be recorded rather than answered with the first's
      // response. Retiring the attempt is what keeps that a real second row.
      attempt.retire();
      void queryClient.invalidateQueries({ queryKey: ['support'] });
      onSaved();
      onClose();
    },
    onError: (e) =>
      setError(
        e instanceof OfflineError
          ? 'No connection. If it was recorded, pressing save again will not record it twice.'
          : e instanceof ApiError
            ? e.message
            : 'That did not save.',
      ),
  });

  const max = kind === 'nps' ? 10 : 5;
  const needsScore = kind !== 'cancellation';
  const ready = (!needsScore || score !== '') && (kind !== 'cancellation' || comment.trim().length > 0);

  return (
    <Drawer
      open
      onClose={onClose}
      kicker="Feedback"
      title="Record feedback"
      footer={
        <Button variant="cta" full disabled={!ready || !online || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : !online ? 'Offline' : 'Save'}
        </Button>
      }
    >
      <div className="border-b border-line p-3">
        <Label>Kind</Label>
        <select
          aria-label="Feedback kind"
          className="mt-1.5 min-h-9 w-full border border-line bg-panel px-2 text-[13px] text-foam"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setScore('');
          }}
        >
          <option value="csat">CSAT — how was the service</option>
          <option value="nps">NPS — would they recommend us</option>
          <option value="class">Class rating</option>
          <option value="trainer">Trainer rating</option>
          <option value="facility">Facility</option>
          <option value="cancellation">Cancellation reason</option>
        </select>
      </div>

      {needsScore ? (
        <div className="border-b border-line p-3">
          <Label>Score (0–{max === 10 ? 10 : 5})</Label>
          <input
            type="number"
            min={kind === 'nps' ? 0 : 1}
            max={max}
            aria-label={`Score out of ${max}`}
            className="sf-field mt-1.5 !min-h-9 !w-24 !text-right !text-[13px] tabular-nums"
            value={score}
            onChange={(e) => setScore(e.target.value)}
          />
        </div>
      ) : null}

      <div className="border-b border-line p-3">
        <Label>{kind === 'cancellation' ? 'Reason they gave' : 'Comment'}</Label>
        <textarea
          className="sf-field mt-1.5 !min-h-[80px] !text-[13px]"
          aria-label={kind === 'cancellation' ? 'Reason they gave' : 'Comment'}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      </div>

      <div className="border-b border-line p-3">
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={anonymous}
            onChange={(e) => setAnonymous(e.target.checked)}
          />
          <span className="text-[13px] leading-relaxed">
            Record this anonymously
            <span className="mt-0.5 block text-[11px] text-foam-45">
              No member is written against the response at all — not hidden, absent. It cannot be linked back
              afterwards, including by us.
            </span>
          </span>
        </label>
      </div>

      {error ? (
        <p role="alert" className="border-t border-line bg-wash-chum px-3 py-2 text-[12px] text-foam-80">
          {error}
        </p>
      ) : null}
    </Drawer>
  );
}
