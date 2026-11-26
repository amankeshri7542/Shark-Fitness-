import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, OfflineError, api } from '../../lib/api';
import { Button, ErrorState, Label, Panel, SectionRule, Skeleton, cx } from '../../ui/primitives';

/**
 * The weekly check-in (PF-NUTR-003): six 1–5 scales and a note, read by the
 * member's coach in Nutrition & Habits.
 *
 * It is sent straight to the server rather than through the offline outbox:
 * the note is scanned for safety signals there, and when one is found the
 * answer is a "a person will read this" response that must be shown now, not
 * after a later sync. Every word of that response comes from the server and is
 * rendered as sent (plain copy on a safety surface).
 */

type ScaleKey = 'adherence' | 'energy' | 'hunger' | 'sleep' | 'soreness' | 'mood';

interface Scale {
  key: ScaleKey;
  label: string;
  low: string;
  high: string;
}

interface CheckIn extends Record<ScaleKey, number> {
  id: string;
  weekStart: string;
  note: string;
  submitted: boolean;
  submittedRelative: string | null;
  coachReply: string | null;
  safetyEscalated: boolean;
}

export interface CheckInPayload {
  optedOut: boolean;
  weekStart: string;
  weekLabel: string;
  scales: Scale[];
  checkIn: CheckIn | null;
  coach: { name: string | null };
  privacyNote: string;
}

interface SafetyResponse {
  headline: string;
  body: string;
  whatHappensNext: string[];
  resources: Array<{ title: string; detail: string; contact: string | null }>;
  reference: string | null;
}

interface SubmitResponse {
  checkIn: CheckIn | null;
  safety: SafetyResponse | null;
  acknowledgement: string | null;
}

function failure(error: unknown): string {
  if (error instanceof OfflineError) return 'You are offline. Nothing was sent. Try again when you are back online.';
  if (error instanceof ApiError) return error.message;
  return 'Your check-in did not send. Try again.';
}

export function WeeklyCheckIn() {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Partial<Record<ScaleKey, number>>>({});
  const [note, setNote] = useState('');

  const query = useQuery({
    queryKey: ['habits', 'check-in'],
    queryFn: () => api<CheckInPayload>('/member/habits/check-in'),
  });

  const submit = useMutation({
    mutationFn: (payload: CheckInPayload) =>
      api<SubmitResponse>('/member/habits/check-in', {
        method: 'POST',
        body: { weekStart: payload.weekStart, ...values, note: note.trim() },
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['habits', 'check-in'] }),
  });

  if (query.isPending) return <Skeleton className="h-40" />;
  if (query.isError) {
    return (
      <ErrorState
        title="Could not load this week’s check-in"
        body={query.error instanceof OfflineError ? 'You are offline. The check-in needs a connection.' : 'Try again in a moment.'}
        onRetry={() => void query.refetch()}
        requestId={query.error instanceof ApiError ? query.error.requestId : undefined}
      />
    );
  }

  const data = query.data;
  // Nutrition and recovery tracking is switched off (PF-NUTR-006): no prompt.
  if (data.optedOut) return null;
  const coachName = data.coach.name ?? 'Your coach';

  return (
    <section aria-labelledby="weekly-check-in">
      <SectionRule>
        <span id="weekly-check-in">Weekly check-in</span>
      </SectionRule>
      <Panel className="mt-3 flex flex-col gap-4 p-4">
        <div>
          <Label>{data.weekLabel}</Label>
          <p className="mt-1 text-[12px] leading-relaxed text-foam-50">{data.privacyNote}</p>
        </div>

        {submit.data?.safety ? (
          <div role="status" className="flex flex-col gap-2">
            <p className="text-[15px] font-semibold">{submit.data.safety.headline}</p>
            <p className="text-[13px] leading-relaxed text-foam-80">{submit.data.safety.body}</p>
            <ul className="list-disc pl-5 text-[13px] leading-relaxed text-foam-80">
              {submit.data.safety.whatHappensNext.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ul>
            {submit.data.safety.resources.map((r) => (
              <div key={r.title} className="border-l-2 border-line-strong pl-3 text-[13px]">
                <p className="font-semibold">{r.title}</p>
                <p className="text-foam-65">{r.detail}</p>
                {r.contact ? <p className="text-foam-80">{r.contact}</p> : null}
              </div>
            ))}
            {submit.data.safety.reference ? <p className="text-[12px] text-foam-50">Reference {submit.data.safety.reference}</p> : null}
          </div>
        ) : data.checkIn?.submitted ? (
          <div className="flex flex-col gap-2 text-[13px]">
            <p className="text-foam-80">
              {submit.data?.acknowledgement ?? `Sent ${data.checkIn.submittedRelative ?? 'this week'}.`}
            </p>
            {data.checkIn.note ? <p className="whitespace-pre-wrap text-foam-65">“{data.checkIn.note}”</p> : null}
            {data.checkIn.coachReply ? (
              <div className="border-l-2 border-sonar pl-3">
                <Label>{coachName} replied</Label>
                <p className="mt-1 whitespace-pre-wrap leading-relaxed">{data.checkIn.coachReply}</p>
              </div>
            ) : (
              <p className="text-foam-50">
                {data.checkIn.safetyEscalated ? 'A person will read this before anything else happens.' : `Waiting for ${coachName} to reply.`}
              </p>
            )}
          </div>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              submit.mutate(data);
            }}
          >
            {data.scales.map((scale) => (
              <fieldset key={scale.key} className="flex flex-col gap-1.5">
                <legend className="font-utility text-[10px] font-semibold uppercase tracking-[0.14em] text-foam-50">{scale.label}</legend>
                <div className="flex border border-line">
                  {[1, 2, 3, 4, 5].map((n, index) => {
                    const chosen = values[scale.key] === n;
                    return (
                      <label
                        key={n}
                        className={cx(
                          'grid min-h-11 flex-1 cursor-pointer place-items-center text-[13px] font-semibold focus-within:outline focus-within:outline-2 focus-within:outline-sonar',
                          index > 0 && 'border-l border-line',
                          chosen ? 'bg-sonar text-on-accent' : 'text-foam-65 hover:text-foam',
                        )}
                      >
                        <input
                          type="radio"
                          className="sr-only"
                          name={scale.key}
                          value={n}
                          checked={chosen}
                          aria-label={`${scale.label}: ${n} of 5${n === 1 ? ` (${scale.low})` : n === 5 ? ` (${scale.high})` : ''}`}
                          onChange={() => setValues((v) => ({ ...v, [scale.key]: n }))}
                        />
                        {n}
                      </label>
                    );
                  })}
                </div>
                <div className="flex justify-between text-[11px] text-foam-35">
                  <span>{scale.low}</span>
                  <span>{scale.high}</span>
                </div>
              </fieldset>
            ))}
            <label className="flex flex-col gap-1.5">
              <span className="font-utility text-[10px] font-semibold uppercase tracking-[0.14em] text-foam-50">Anything else (optional)</span>
              <textarea className="sf-field min-h-20" maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
            {submit.isError ? (
              <p role="alert" className="text-[12px] text-chum">
                {failure(submit.error)}
              </p>
            ) : null}
            <Button type="submit" variant="cta" disabled={submit.isPending || data.scales.some((s) => values[s.key] === undefined)}>
              {submit.isPending ? 'Sending…' : `Send to ${coachName}`}
            </Button>
          </form>
        )}
      </Panel>
    </section>
  );
}
