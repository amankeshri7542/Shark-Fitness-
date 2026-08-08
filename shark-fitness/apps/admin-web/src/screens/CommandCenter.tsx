import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAdmin } from '../lib/store';
import { OccupancyTrace } from '../ui/OccupancyTrace';
import {
  Bar,
  Button,
  Chip,
  Display,
  ErrorState,
  Freshness,
  Label,
  Metric,
  Panel,
  Seam,
  Skeleton,
  cx,
} from '../ui/console';
import { Page } from '../ui/shell';

interface Kpi {
  key: string;
  label: string;
  display: string;
  changePct: number | null;
  direction: 'up' | 'down' | 'flat';
  goodDirection: 'up' | 'down' | 'neutral';
  freshness: 'realtime' | 'near_realtime' | 'batch';
  asOf: string;
  drillTo: string | null;
  unavailableReason: string | null;
  definition: string;
}

interface Alert {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  kind: string;
  title: string;
  detail: string;
  count: number;
  actionLabel: string;
  actionTo: string;
}

interface Dashboard {
  scope: { branchNames: string[]; allBranches: boolean };
  asOf: string;
  alerts: Alert[];
  kpis: Kpi[];
  occupancy: {
    inside: number;
    capacity: number;
    label: string;
    hourly: number[];
    currentHour: number;
    byBranch: Array<{ id: string; name: string; inside: number; capacity: number }>;
    opensHour: number;
    closesHour: number;
  };
  activity: Array<{
    id: string;
    relativeTime: string;
    granted: boolean;
    decision: string;
    memberName: string;
    memberNo: string;
    branchName: string;
  }>;
  classes: Array<{
    id: string;
    name: string;
    localTime: string;
    roomName: string;
    trainerName: string;
    booked: number;
    capacity: number;
    fillPct: number;
    cancelled: boolean;
    branchName: string;
  }>;
}

export default function CommandCenterScreen() {
  const branchId = useAdmin((s) => s.activeBranchId);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard', branchId],
    queryFn: () => api<Dashboard>('/admin/dashboard', { branchId }),
    refetchInterval: 30_000,
  });

  if (isLoading) return <DashboardSkeleton />;

  if (error || !data) {
    return (
      <Page title="Command" kicker="Today">
        <ErrorState
          title="Could not load the console"
          body="The API did not answer. Nothing has changed — try again."
          onRetry={() => void refetch()}
        />
      </Page>
    );
  }

  return (
    <Page
      title="Command"
      kicker={data.scope.allBranches ? `All branches · ${data.scope.branchNames.length}` : data.scope.branchNames[0]}
      actions={<Freshness kind="realtime" asOf={data.asOf} />}
    >
      {/* Exceptions before vanity metrics. This is the whole point of the
          screen and it sits above everything else (PF-DASH-005). */}
      {data.alerts.length > 0 ? (
        <div className="seam-y flex flex-col border-b border-line">
          {data.alerts.map((alert) => (
            <div
              key={alert.id}
              className={cx(
                'flex items-center gap-3 px-4 py-2.5',
                alert.severity === 'critical' ? 'bg-wash-chum' : 'bg-wash-flare',
              )}
            >
              <span
                aria-hidden="true"
                className={cx(
                  'font-display text-[14px]',
                  alert.severity === 'critical' ? 'text-chum' : 'text-flare',
                )}
              >
                {alert.severity === 'critical' ? '×' : '!'}
              </span>
              <span className="font-utility text-[12px] font-semibold uppercase tracking-[0.1em]">{alert.title}</span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-foam-65">{alert.detail}</span>
              <Link to={alert.actionTo as '/'}>
                <Button variant="outline">{alert.actionLabel}</Button>
              </Link>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-3 border-b border-line bg-wash-kelp px-4 py-2.5">
          <span aria-hidden="true" className="text-kelp">
            ✓
          </span>
          <span className="font-utility text-[12px] font-semibold uppercase tracking-[0.1em]">Nothing needs you</span>
          <span className="text-[12px] text-foam-65">
            No failed payments, denials, breached tickets or safety work orders.
          </span>
        </div>
      )}

      {/* The signature: a sonar readout of the building. */}
      <div className="border-b border-line">
        <OccupancyTrace
          hourly={data.occupancy.hourly}
          currentHour={data.occupancy.currentHour}
          inside={data.occupancy.inside}
          capacity={data.occupancy.capacity}
          label={data.occupancy.label}
          opensHour={data.occupancy.opensHour}
          closesHour={data.occupancy.closesHour}
        />
      </div>

      {/* KPI strip: cells share edges, no gaps. */}
      <Seam className="flex-wrap border-b border-line">
        {data.kpis.map((kpi) => (
          <KpiCell key={kpi.key} kpi={kpi} />
        ))}
      </Seam>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_360px]">
        <Panel title="Today's classes" className="border-b border-line xl:border-r">
          {data.classes.length === 0 ? (
            <p className="p-4 text-[13px] text-foam-45">Nothing else scheduled today.</p>
          ) : (
            <table className="console-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Class</th>
                  <th>Trainer</th>
                  <th>Room</th>
                  <th>Fill</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.classes.map((s) => (
                  <tr key={s.id}>
                    <td className="font-display text-[15px] tabular-nums">{s.localTime}</td>
                    <td>
                      <div className="font-utility text-[13px] font-semibold">{s.name}</div>
                      <div className="text-[11px] text-foam-45">{s.branchName}</div>
                    </td>
                    <td className="text-[12px] text-foam-65">{s.trainerName}</td>
                    <td className="text-[12px] text-foam-65">{s.roomName}</td>
                    <td>
                      <div className="flex items-center gap-2">
                        <Bar
                          value={s.fillPct}
                          className="w-16"
                          tone={s.fillPct >= 95 ? 'warn' : 'accent'}
                        />
                        <span className="font-display text-[13px] tabular-nums">
                          {s.booked}/{s.capacity}
                        </span>
                      </div>
                    </td>
                    <td data-numeric>
                      {s.cancelled ? (
                        <Chip tone="bad">Cancelled</Chip>
                      ) : s.booked >= s.capacity ? (
                        <Chip tone="warn">Full</Chip>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Live door" className="border-b border-line">
          <ul className="seam-y flex flex-col">
            {data.activity.map((a) => (
              <li key={a.id} className="flex items-center gap-2.5 px-3.5 py-2">
                <span
                  aria-hidden="true"
                  className={cx('h-1.5 w-1.5 flex-none', a.granted ? 'bg-kelp' : 'bg-chum')}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px]">{a.memberName}</div>
                  <div className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
                    {a.memberNo} · {a.branchName}
                  </div>
                </div>
                {!a.granted ? <Chip tone="bad">Denied</Chip> : null}
                <span className="flex-none font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
                  {a.relativeTime}
                </span>
              </li>
            ))}
            {data.activity.length === 0 ? (
              <li className="px-3.5 py-4 text-[12px] text-foam-45">No entries yet today.</li>
            ) : null}
          </ul>
        </Panel>
      </div>

      <Panel title="Occupancy by branch">
        <Seam className="flex-wrap">
          {data.occupancy.byBranch.map((b) => (
            <div key={b.id} className="min-w-[200px] flex-1 px-3.5 py-3">
              <Label>{b.name}</Label>
              <div className="mt-1.5 flex items-baseline gap-1.5">
                <Metric value={b.inside} size="md" />
                <span className="text-[11px] text-foam-45">/ {b.capacity}</span>
              </div>
              <Bar className="mt-2" value={b.inside} max={b.capacity} />
            </div>
          ))}
        </Seam>
      </Panel>
    </Page>
  );
}

function KpiCell({ kpi }: { kpi: Kpi }) {
  const good =
    kpi.goodDirection === 'neutral'
      ? null
      : kpi.direction === kpi.goodDirection;

  const body = (
    <div className="min-w-[160px] flex-1 px-3.5 py-3">
      <div className="flex items-start gap-1.5">
        <Label>{kpi.label}</Label>
        <span
          className="cursor-help font-utility text-[10px] text-foam-25"
          title={kpi.definition}
          aria-label={`Definition: ${kpi.definition}`}
        >
          ⓘ
        </span>
      </div>

      {kpi.unavailableReason ? (
        <>
          <div className="mt-1.5 font-display text-[22px] leading-none text-foam-25">—</div>
          <p className="mt-1 text-[11px] leading-snug text-foam-35">{kpi.unavailableReason}</p>
        </>
      ) : (
        <>
          <div className="mt-1.5">
            <Metric value={kpi.display} size="md" />
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            {kpi.changePct !== null ? (
              <span
                className={cx(
                  'font-utility text-[10px] font-semibold uppercase tracking-[0.1em]',
                  good === null ? 'text-foam-45' : good ? 'text-kelp' : 'text-flare',
                )}
              >
                <span aria-hidden="true">{kpi.direction === 'up' ? '▲' : kpi.direction === 'down' ? '▼' : '—'}</span>{' '}
                {Math.abs(kpi.changePct)}%
              </span>
            ) : null}
            <Freshness kind={kpi.freshness} asOf={kpi.asOf} />
          </div>
        </>
      )}
    </div>
  );

  // Every KPI drills into the filtered list that produced it (PF-DASH-002).
  return kpi.drillTo && !kpi.unavailableReason ? (
    <Link to={kpi.drillTo as '/'} className="min-w-[160px] flex-1 hover:bg-wash-sonar-soft">
      {body}
    </Link>
  ) : (
    body
  );
}

function DashboardSkeleton() {
  return (
    <Page title="Command" kicker="Loading">
      <Skeleton className="h-10 w-full" />
      <div className="border-b border-line p-4">
        <Skeleton className="h-32 w-full" />
      </div>
      <Seam className="flex-wrap border-b border-line">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="min-w-[160px] flex-1 px-3.5 py-3">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-2 h-6 w-16" />
          </div>
        ))}
      </Seam>
      <Skeleton className="m-4 h-64" />
    </Page>
  );
}
