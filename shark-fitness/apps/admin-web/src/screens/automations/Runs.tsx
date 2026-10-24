import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, api } from '../../lib/api';
import {
  Chip,
  EmptyState,
  ErrorState,
  Label,
  Segmented,
  Skeleton,
  Table,
  TableScroll,
  TD,
  TH,
  THead,
  TR,
  Toolbar,
  type Tone,
} from '../../ui/console';

/* ============================================================================
   What actually happened (PF-COMM-005).

   Every decision, including the ones not to send. "Why did my member not get
   the renewal reminder" is the question this module gets asked, and it is
   answered here or nowhere.
   ========================================================================= */

type Outcome = 'all' | 'sent' | 'queued' | 'suppressed' | 'failed' | 'dry_run';

const TONE: Record<string, Tone> = {
  sent: 'good',
  queued: 'warn',
  suppressed: 'neutral',
  failed: 'bad',
  dry_run: 'accent',
};

const LABEL: Record<string, string> = {
  sent: 'Sent',
  queued: 'Queued',
  suppressed: 'Held',
  failed: 'Failed',
  dry_run: 'Rehearsed',
};

interface RunRow {
  id: string;
  at: string;
  automationName: string;
  memberName: string | null;
  outcome: string;
  reason: string;
  channel: string;
  dueAt: string | null;
  attempts: number;
}

export default function Runs() {
  const [outcome, setOutcome] = useState<Outcome>('all');

  const runs = useQuery({
    queryKey: ['automations', 'runs', outcome],
    queryFn: () =>
      api<{ items: RunRow[] }>(`/admin/automations/runs?limit=200${outcome === 'all' ? '' : `&outcome=${outcome}`}`),
  });

  return (
    <>
      <Toolbar>
        <Label>Outcome</Label>
        <Segmented
          label="Outcome"
          size="md"
          value={outcome}
          onChange={setOutcome}
          options={[
            { value: 'all', label: 'all' },
            { value: 'sent', label: 'sent' },
            { value: 'queued', label: 'queued' },
            { value: 'suppressed', label: 'held' },
            { value: 'dry_run', label: 'rehearsed' },
            { value: 'failed', label: 'failed' },
          ]}
        />
      </Toolbar>

      {runs.isLoading ? (
        <Skeleton className="h-64" />
      ) : runs.error || !runs.data ? (
        <ErrorState
          title="The history could not be read"
          body={runs.error instanceof ApiError ? runs.error.message : 'The server did not answer.'}
          onRetry={() => void runs.refetch()}
        />
      ) : runs.data.items.length === 0 ? (
        <EmptyState
          title="Nothing here yet"
          body={
            outcome === 'all'
              ? 'Automations record every decision they make, including the ones not to send. Run one to see what it would do.'
              : 'No runs with that outcome.'
          }
        />
      ) : (
        <TableScroll>
          <Table label="Automation history">
            <THead>
              <TH>When</TH>
              <TH>Rule</TH>
              <TH>Member</TH>
              <TH>Channel</TH>
              <TH>Outcome</TH>
              <TH>Delivery detail</TH>
            </THead>
            <tbody>
              {runs.data.items.map((row) => (
                <TR key={row.id}>
                  <TD>{new Date(row.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</TD>
                  <TD>{row.automationName}</TD>
                  <TD>{row.memberName ?? '—'}</TD>
                  <TD className="capitalize">{row.channel.replace(/_/g, '-')}</TD>
                  <TD>
                    <Chip tone={TONE[row.outcome] ?? 'neutral'}>{LABEL[row.outcome] ?? row.outcome}</Chip>
                  </TD>
                  <TD>
                    {row.reason || '—'}
                    {row.dueAt && row.outcome === 'queued' ? (
                      <span className="block text-[10px] text-foam-35">
                        Due {new Date(row.dueAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
                      </span>
                    ) : null}
                    {row.attempts > 0 ? <span className="block text-[10px] text-foam-35">{row.attempts} attempt{row.attempts === 1 ? '' : 's'}</span> : null}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </TableScroll>
      )}
    </>
  );
}
