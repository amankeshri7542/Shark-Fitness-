import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../../lib/api';
import { Button, Chip, Label, Skeleton, cx } from '../../ui/console';

/* ============================================================================
   Who this reaches, and who it does not.

   The second list is the one worth building. An operator looking at "142
   recipients" learns nothing they could act on; an operator looking at "38
   held because they never agreed to SMS" learns that their consent capture at
   the desk is broken, which is worth more than the campaign.
   ========================================================================= */

interface PreviewPayload {
  summary: {
    considered: number;
    suppressed: number;
    bySuppression: Array<{ code: string; reason: string; count: number }>;
  };
  channel: string;
  metered: boolean;
  estimatedCostMinor: number;
  recipients: Array<{ memberId: string; name: string; branchName: string; preview: string }>;
  suppressed: Array<{ memberId: string; name: string; code: string | null; reason: string }>;
}

export default function Preview({ automationId }: { automationId: string }) {
  const queryClient = useQueryClient();

  const preview = useQuery({
    queryKey: ['automations', 'preview', automationId],
    queryFn: () => api<PreviewPayload>(`/admin/automations/${automationId}/preview`),
  });

  const run = useMutation({
    mutationFn: () => api<{ dryRun: boolean; sent: number; suppressed: number }>(`/admin/automations/${automationId}/run`, { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['automations'] });
    },
  });

  if (preview.isLoading) return <Skeleton className="h-48" />;
  if (preview.error || !preview.data) {
    return (
      <p className="border-b border-line bg-wash-chum px-4 py-3 text-[12px] leading-relaxed text-foam-80">
        {preview.error instanceof ApiError ? preview.error.message : 'The audience could not be read.'}
      </p>
    );
  }

  const { summary, recipients, suppressed, metered, estimatedCostMinor } = preview.data;
  const wouldSend = recipients.length;

  return (
    <section aria-label="Who this reaches" className="border-b border-line">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-hull px-4 py-2.5">
        <h3 className="font-utility text-[10px] font-semibold uppercase tracking-[0.18em] text-foam-45">
          Who this reaches
        </h3>
        <span className="font-utility text-[10px] uppercase tracking-[0.12em] text-foam-35">
          {summary.considered} considered
        </span>
        {metered && wouldSend > 0 ? (
          // PF-COMM-006: the cost is stated before the send, not after it.
          <Chip tone="warn">about ₹{(estimatedCostMinor / 100).toFixed(2)}</Chip>
        ) : null}
        <span className="flex-1" />
        <Button
          variant="outline"
          onClick={() => run.mutate()}
          pending={run.isPending}
          pendingLabel="Running…"
        >
          Run it now
        </Button>
      </header>

      {run.data ? (
        <p className="border-b border-line bg-wash-sonar-soft px-4 py-2.5 text-[12px] leading-relaxed text-foam-80">
          {run.data.dryRun
            ? `Rehearsed against ${run.data.suppressed + run.data.sent} members. Nobody was messaged.`
            : `Sent to ${run.data.sent}. ${run.data.suppressed} held.`}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-px bg-line xl:grid-cols-2">
        <div className="bg-panel">
          <div className="flex items-baseline gap-2 px-4 py-2.5">
            <Label>Would receive it</Label>
            <span className="font-display text-[16px] leading-none tabular-nums">{wouldSend}</span>
          </div>
          {recipients.length === 0 ? (
            <p className="px-4 pb-3 text-[12px] leading-relaxed text-foam-45">
              Nobody, right now. That is not necessarily wrong — look at what is holding them.
            </p>
          ) : (
            <ul className="divide-y divide-line border-t border-line">
              {recipients.map((person) => (
                <li key={person.memberId} className="px-4 py-2.5">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-[13px]">{person.name}</span>
                    <span className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
                      {person.branchName}
                    </span>
                  </div>
                  {/* The real message, rendered against the real member. A
                      preview showing the template rather than the result is a
                      preview of the wrong thing. */}
                  <p className="mt-1 border-l-2 border-line-strong pl-2 text-[11px] leading-relaxed text-foam-65">
                    {person.preview}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="bg-panel">
          <div className="flex items-baseline gap-2 px-4 py-2.5">
            <Label>Held back</Label>
            <span className="font-display text-[16px] leading-none tabular-nums">{summary.suppressed}</span>
          </div>
          {summary.bySuppression.length === 0 ? (
            <p className="px-4 pb-3 text-[12px] text-foam-45">Nothing is being held.</p>
          ) : (
            <ul className="divide-y divide-line border-t border-line">
              {summary.bySuppression.map((entry) => (
                <li key={entry.code} className="flex items-start gap-3 px-4 py-2.5">
                  <span
                    className={cx(
                      'mt-0.5 font-display text-[14px] leading-none tabular-nums',
                      entry.code === 'no_consent' ? 'text-flare' : 'text-foam-45',
                    )}
                  >
                    {entry.count}
                  </span>
                  <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-foam-65">{entry.reason}</p>
                </li>
              ))}
            </ul>
          )}
          {suppressed.length > 0 ? (
            <p className="border-t border-line px-4 py-2 font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
              e.g. {suppressed.slice(0, 3).map((s) => s.name).join(', ')}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
