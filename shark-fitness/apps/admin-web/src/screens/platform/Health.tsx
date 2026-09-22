import { useQuery } from '@tanstack/react-query';
import type { PlatformHealth } from '@shark/contracts';
import { ApiError, api } from '../../lib/api';
import { Chip, ErrorState, Label, Panel, Seam, Skeleton, Table, TableScroll, TD, TH, THead, TR } from '../../ui/console';
import { METER_TONE } from './Tenants';

/**
 * Service health (PF-PLAT-003).
 *
 * Four figures and two lists, chosen because each one answers a question an
 * operator has at 2am and cannot answer any other way: is the scheduler alive,
 * is the outbox draining, is anybody signed in as a customer right now, and
 * which gyms are about to hit a wall.
 *
 * Not a wall of sparklines. This deployment has no metrics backend and
 * inventing one on the client would be a chart of numbers the server does not
 * keep — see the note in DEPLOY-FREE.md about what this stack genuinely
 * observes.
 */
export default function Health() {
  const health = useQuery({
    queryKey: ['platform', 'health'],
    queryFn: () => api<PlatformHealth>('/platform/health'),
    refetchInterval: 60_000,
  });

  if (health.isLoading) return <Skeleton className="h-64" />;
  if (health.error || !health.data) {
    return (
      <ErrorState
        title="Health could not be read"
        body={health.error instanceof ApiError ? health.error.message : 'The server did not answer.'}
        onRetry={() => void health.refetch()}
      />
    );
  }

  const h = health.data;

  return (
    <>
      <Seam className="border-b border-line">
        <Figure label="Customers" value={h.tenants.total} detail={`${h.tenants.active} active · ${h.tenants.trial} trial · ${h.tenants.suspended} suspended`} />
        <Figure label="Members" value={h.members} detail="across every gym" />
        <Figure label="Check-ins" value={h.checkIns24h} detail="last 24 hours" />
        <Figure
          label="Support sessions"
          value={h.activeSupportSessions}
          detail={h.activeSupportSessions === 0 ? 'nobody is inside a customer account' : 'open right now'}
          tone={h.activeSupportSessions > 0 ? 'warn' : 'default'}
        />
      </Seam>

      <div className="grid grid-cols-1 gap-px bg-line xl:grid-cols-2">
        <Panel title="Scheduled jobs">
          <TableScroll>
            <Table label="Scheduled jobs">
              <THead>
                <TH>Job</TH>
                <TH numeric>Every</TH>
                <TH>Last success</TH>
                <TH>Last failure</TH>
                <TH>Next expected</TH>
                <TH>Health</TH>
              </THead>
              <tbody>
                {h.jobs.map((job) => (
                  <TR key={job.name}>
                    <TD>{job.name.replace(/-/g, ' ')}</TD>
                    <TD numeric>{job.everyMinutes < 60 ? `${job.everyMinutes} min` : `${job.everyMinutes / 60} h`}</TD>
                    <TD>
                      {job.lastSuccessfulRunAt
                        ? new Date(job.lastSuccessfulRunAt).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })
                        : 'Never'}
                    </TD>
                    <TD>
                      {job.lastFailedRunAt
                        ? new Date(job.lastFailedRunAt).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })
                        : 'Never'}
                      {job.lastFailureMessage ? <span className="block max-w-[36ch] text-[10px] text-chum">{job.lastFailureMessage}</span> : null}
                    </TD>
                    <TD>
                      {job.nextExpectedAt
                        ? new Date(job.nextExpectedAt).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })
                        : '—'}
                    </TD>
                    <TD>
                      <Chip tone={job.health === 'failing' || job.health === 'stale' ? 'bad' : job.health === 'healthy' ? 'good' : 'neutral'}>
                        {job.health}
                      </Chip>
                      {job.durationMs !== null ? <span className="ml-2 text-[10px] text-foam-35">{job.durationMs} ms</span> : null}
                      {job.error ? <span className="block max-w-[36ch] text-[10px] text-chum">{job.error}</span> : null}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </TableScroll>
          <p className="px-3.5 py-2.5 text-[11px] leading-relaxed text-foam-45">
            In-process timers, one set per running instance. See the deployment notes before running more than one.
          </p>
        </Panel>

        <Panel title="Queue">
          <div className="flex flex-col gap-1 px-3.5 py-3">
            <Label>Outbox waiting to deliver</Label>
            <div className="font-display text-[22px] leading-none tabular-nums">{h.outboxPending.toLocaleString('en-IN')}</div>
            <p className="mt-1 max-w-[60ch] text-[11px] leading-relaxed text-foam-45">
              Events recorded and not yet dispatched. A number that only grows means nothing is draining them.
            </p>
          </div>
        </Panel>
      </div>

      <Panel title="Gyms near a limit">
        {h.metersNeedingAttention.length === 0 ? (
          <p className="px-3.5 py-3 text-[12px] text-foam-45">Nobody is close to a quota.</p>
        ) : (
          <TableScroll>
            <Table label="Gyms near a limit">
              <THead>
                <TH>Gym</TH>
                <TH>Meter</TH>
                <TH numeric>Used</TH>
                <TH numeric>Limit</TH>
                <TH>Standing</TH>
              </THead>
              <tbody>
                {h.metersNeedingAttention.map((m) => (
                  <TR key={`${m.tenantId}-${m.meter}`}>
                    <TD>{m.tenantName}</TD>
                    <TD className="capitalize">{m.meter.replace(/_/g, ' ')}</TD>
                    <TD numeric>{m.used.toLocaleString('en-IN')}</TD>
                    <TD numeric>{m.limit.toLocaleString('en-IN')}</TD>
                    <TD>
                      <Chip tone={METER_TONE[m.health]}>{m.percent !== null ? `${m.percent}%` : m.health}</Chip>
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        )}
      </Panel>

      <p className="px-3.5 py-2.5 font-utility text-[10px] uppercase tracking-[0.12em] text-foam-35">
        Computed {new Date(h.computedAt).toLocaleTimeString('en-IN', { timeStyle: 'short' })}
      </p>
    </>
  );
}

function Figure({ label, value, detail, tone }: { label: string; value: number; detail: string; tone?: 'warn' | 'default' }) {
  return (
    <div className="min-w-[170px] flex-1 px-3.5 py-3">
      <Label>{label}</Label>
      <div className={`mt-1.5 font-display text-[22px] leading-none tabular-nums ${tone === 'warn' && value > 0 ? 'text-flare' : ''}`}>
        {value.toLocaleString('en-IN')}
      </div>
      <div className="mt-1 text-[10px] leading-snug text-foam-35">{detail}</div>
    </div>
  );
}
