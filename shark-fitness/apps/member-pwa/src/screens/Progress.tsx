import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useCopy } from '../lib/store';
import { ScreenBody, Stack, Surface } from '../ui/shell';
import {
  Bar,
  Chip,
  Display,
  EmptyState,
  ErrorState,
  Eyebrow,
  Label,
  Metric,
  Panel,
  Seam,
  SeamCell,
  SectionRule,
  Skeleton,
  cx,
} from '../ui/primitives';

interface RecoveryRegion {
  muscle: string;
  label: string;
  side: 'front' | 'back';
  recoveredPct: number;
  lastWorkedLabel: string;
  setsLast7d: number;
  note: string;
}

interface ProgressPayload {
  rangeWeeks: number;
  branchName: string;
  tonnageChangePct: number;
  adherencePct: number;
  newPrCount: number;
  weeklyTonnage: Array<{ label: string; value: number; estimated: boolean }>;
  attendance: Array<{ label: string; sessions: number; planned: number; branchClosed: boolean }>;
  averageSessionsPerWeek: number;
  weeklyTarget: number;
  latestMeasurement: { takenOn: string; weightKg: number | null; bodyFatPct: number | null; leanMassKg: number | null } | null;
  measurementTrend: Array<{ label: string; value: number }>;
  bodyComposition: {
    takenOn: string;
    comparedWith: string | null;
    items: Array<{ label: string; value: string; unit: string | null; delta: string | null; improving: boolean | null }>;
  } | null;
  goals: Array<{
    id: string;
    title: string;
    current: number;
    target: number;
    unit: string;
    targetDate: string;
    progressPct: number;
    onTrack: boolean;
    paceWarning: string | null;
  }>;
  insufficientData: string | null;
  estimateNote: string;
}

interface Records {
  items: Array<{ id: string; exerciseName: string; display: string; delta: string | null; achievedAt: string }>;
}

export default function ProgressScreen() {
  const copy = useCopy();
  const [region, setRegion] = useState<string>('chest');

  const progress = useQuery({
    queryKey: ['progress'],
    queryFn: () => api<ProgressPayload>('/member/progress'),
  });

  const recovery = useQuery({
    queryKey: ['progress', 'recovery'],
    queryFn: () => api<RecoveryRegion[] | { regions: RecoveryRegion[] }>('/member/progress/recovery'),
  });

  const records = useQuery({
    queryKey: ['progress', 'records'],
    queryFn: () => api<Records>('/member/progress/records'),
  });

  if (progress.isLoading) return <ProgressSkeleton />;

  if (progress.error || !progress.data) {
    return (
      <ScreenBody>
        <Stack>
          <ErrorState
            title="Could not load your progress"
            body="Your logged sessions are safe on this phone and on the server."
            onRetry={() => void progress.refetch()}
          />
        </Stack>
      </ScreenBody>
    );
  }

  const d = progress.data;
  const regions = Array.isArray(recovery.data) ? recovery.data : (recovery.data?.regions ?? []);
  const selected = regions.find((r) => r.muscle === region) ?? regions[0] ?? null;
  const peakTonnage = Math.max(1, ...d.weeklyTonnage.map((w) => w.value));

  return (
    <ScreenBody>
      <Surface>
        <Stack>
          <div>
            <Eyebrow>Depth chart · {d.rangeWeeks} weeks</Eyebrow>
            <Display size="lg" className="mt-1.5">
              {copy('progressTitle')}
            </Display>
          </div>

          {d.insufficientData ? (
            <EmptyState
              title="Not enough logged yet"
              body={d.insufficientData}
            />
          ) : (
            <>
              {/* Tonnage trend */}
              <Panel className="p-3.5">
                <div className="flex h-[120px] items-end gap-1.5">
                  {d.weeklyTonnage.map((week, i) => {
                    const recent = i >= d.weeklyTonnage.length - 2;
                    return (
                      <div key={week.label} className="flex h-full flex-1 flex-col justify-end gap-1.5">
                        <div
                          className={cx('w-full', recent ? 'bg-sonar' : 'bg-[rgba(120,190,215,.35)]')}
                          style={{ height: `${Math.max(2, (week.value / peakTonnage) * 100)}%` }}
                          title={`${week.label}: ${Math.round(week.value).toLocaleString('en-IN')} kg`}
                        />
                        <span className="text-center text-[8px] tracking-[0.04em] text-foam-25">{week.label}</span>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-3 flex gap-5 border-t border-line pt-2.5">
                  <div>
                    <Metric value={`${d.tonnageChangePct > 0 ? '+' : ''}${d.tonnageChangePct}%`} size="sm" />
                    <Label className="mt-0.5 block">Tonnage</Label>
                  </div>
                  <div>
                    <Metric value={`${d.adherencePct}%`} size="sm" />
                    <Label className="mt-0.5 block">Adherence</Label>
                  </div>
                  <div>
                    <Metric value={d.newPrCount} size="sm" tone="accent" />
                    <Label className="mt-0.5 block">New PRs</Label>
                  </div>
                </div>
              </Panel>

              {/* Recovery map — the signature member visualisation. */}
              <div>
                <SectionRule>Recovery map</SectionRule>
                <Panel className="p-3.5">
                  <p className="mb-3 text-[12px] text-foam-50">Tap a region. Filled means still recovering.</p>

                  <div className="flex items-start gap-3">
                    <div className="flex flex-none gap-2.5">
                      <BodyMap side="front" regions={regions} selected={region} onSelect={setRegion} />
                      <BodyMap side="back" regions={regions} selected={region} onSelect={setRegion} />
                    </div>

                    <div className="min-w-0 flex-1">
                      {selected ? (
                        <Panel className="p-2.5">
                          <div className="font-utility text-[15px] font-semibold">{selected.label}</div>
                          <div className="mt-1 flex items-baseline gap-1.5">
                            <Metric value={`${selected.recoveredPct}%`} size="md" tone="accent" />
                            <span className="text-[11px] text-foam-50">recovered</span>
                          </div>
                          <Bar
                            className="mt-2"
                            value={selected.recoveredPct}
                            tone={selected.recoveredPct < 45 ? 'warn' : 'accent'}
                          />
                          <p className="mt-2 text-[11px] leading-relaxed text-foam-50">{selected.note}</p>
                          <p className="mt-1.5 font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
                            Last worked {selected.lastWorkedLabel}
                          </p>
                        </Panel>
                      ) : (
                        <p className="text-[12px] text-foam-45">No sets logged yet.</p>
                      )}
                      <p className="mt-2 text-[10px] leading-relaxed text-foam-35">
                        An estimate from logged sets and days since. Not a medical measure.
                      </p>
                    </div>
                  </div>
                </Panel>
              </div>

              {/* Personal records */}
              <div>
                <SectionRule>{copy('prTitle')}</SectionRule>
                {records.data && records.data.items.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    {records.data.items.slice(0, 6).map((pr) => (
                      <div
                        key={pr.id}
                        className="flex items-center gap-3 border-l-2 border-sonar bg-wash-sonar-soft px-3 py-2.5"
                      >
                        <span className="min-w-0 flex-1 truncate font-utility text-[14px] font-semibold">
                          {pr.exerciseName}
                        </span>
                        <span className="font-display text-[17px] tabular-nums">{pr.display}</span>
                        {pr.delta ? (
                          <span className="w-12 text-right text-[11px] text-sonar">{pr.delta}</span>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    title="No records yet"
                    body="Log a few sessions and your best lifts start showing up here automatically."
                  />
                )}
              </div>

              {/* Attendance */}
              <div>
                <SectionRule>Attendance · last {d.attendance.length} weeks</SectionRule>
                <Panel className="p-3.5">
                  <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${d.attendance.length}, 1fr)` }}>
                    {d.attendance.map((week) => (
                      <span
                        key={week.label}
                        title={
                          week.branchClosed
                            ? `${week.label}: branch closed`
                            : `${week.label}: ${week.sessions} of ${week.planned}`
                        }
                        className={cx(
                          'aspect-square border',
                          week.branchClosed ? 'border-dashed border-line-strong' : 'border-line',
                        )}
                        style={
                          week.branchClosed
                            ? undefined
                            : {
                                background:
                                  week.sessions === 0
                                    ? 'transparent'
                                    : `rgba(70,200,221,${Math.min(0.9, 0.22 + week.sessions * 0.19)})`,
                              }
                        }
                      />
                    ))}
                  </div>
                  <p className="mt-2.5 text-[12px] text-foam-50">
                    Averaging {d.averageSessionsPerWeek} sessions a week against a target of {d.weeklyTarget}.
                    {d.attendance.some((w) => w.branchClosed)
                      ? ' Dashed weeks are when the gym was shut — those do not count against you.'
                      : ''}
                  </p>
                </Panel>
              </div>

              {/* Body composition */}
              {d.bodyComposition ? (
                <div>
                  <SectionRule>Body composition · {d.bodyComposition.takenOn}</SectionRule>
                  <Seam>
                    {d.bodyComposition.items.slice(0, 3).map((item) => (
                      <SeamCell key={item.label}>
                        <Label>{item.label}</Label>
                        <div className="mt-1.5">
                          <Metric value={item.value} unit={item.unit ?? undefined} size="md" />
                        </div>
                        {item.delta ? (
                          <p
                            className={cx(
                              'mt-1 text-[11px]',
                              item.improving === null ? 'text-foam-45' : item.improving ? 'text-kelp' : 'text-flare',
                            )}
                          >
                            {item.delta}
                          </p>
                        ) : null}
                      </SeamCell>
                    ))}
                  </Seam>
                  <p className="mt-2 text-[11px] leading-relaxed text-foam-45">
                    Photos and trainer-only fields stay private until you share them.
                  </p>
                </div>
              ) : null}

              {/* Goals */}
              <div>
                <SectionRule>Goals</SectionRule>
                {d.goals.length === 0 ? (
                  <EmptyState
                    title="No goals set"
                    body="A goal gives the plan something to aim at. Your coach can set one, or you can."
                  />
                ) : (
                  <div className="flex flex-col gap-2">
                    {d.goals.map((goal) => (
                      <Panel key={goal.id} className="p-3">
                        <div className="flex items-baseline gap-2">
                          <span className="font-utility text-[14px] font-semibold">{goal.title}</span>
                          <span className="flex-1" />
                          <Chip tone={goal.onTrack ? 'good' : 'warn'}>{goal.onTrack ? 'On track' : 'Behind'}</Chip>
                        </div>
                        <div className="mt-2 flex items-baseline gap-1.5">
                          <Metric value={goal.current} size="sm" />
                          <span className="text-[11px] text-foam-45">
                            of {goal.target} {goal.unit} · by {goal.targetDate}
                          </span>
                        </div>
                        <Bar className="mt-2" value={goal.progressPct} tone={goal.onTrack ? 'accent' : 'warn'} />
                        {goal.paceWarning ? (
                          <p className="mt-2 text-[11px] leading-relaxed text-flare">{goal.paceWarning}</p>
                        ) : null}
                      </Panel>
                    ))}
                  </div>
                )}
              </div>

              <p className="text-[11px] leading-relaxed text-foam-35">{d.estimateNote}</p>
            </>
          )}
        </Stack>
      </Surface>
    </ScreenBody>
  );
}

/**
 * Front and back body diagrams. Regions are absolutely-positioned hit areas
 * over a 74×184 frame — the same construction the prototype used, which keeps
 * every region a real button with a real label rather than an SVG path nobody
 * can tab to.
 */
const FRONT_REGIONS: Array<{ muscle: string; style: React.CSSProperties }> = [
  { muscle: 'front_delt', style: { left: 8, top: 24, width: 16, height: 15 } },
  { muscle: 'side_delt', style: { right: 8, top: 24, width: 16, height: 15 } },
  { muscle: 'chest', style: { left: 24, top: 24, width: 26, height: 22 } },
  { muscle: 'biceps', style: { left: 6, top: 42, width: 13, height: 30 } },
  { muscle: 'forearms', style: { right: 6, top: 42, width: 13, height: 30 } },
  { muscle: 'core', style: { left: 26, top: 48, width: 22, height: 34 } },
  { muscle: 'quads', style: { left: 18, top: 86, width: 17, height: 50 } },
  { muscle: 'calves', style: { left: 20, top: 140, width: 13, height: 34 } },
];

const BACK_REGIONS: Array<{ muscle: string; style: React.CSSProperties }> = [
  { muscle: 'traps', style: { left: 22, top: 22, width: 30, height: 14 } },
  { muscle: 'lats', style: { left: 16, top: 38, width: 42, height: 32 } },
  { muscle: 'triceps', style: { left: 5, top: 40, width: 12, height: 28 } },
  { muscle: 'upper_back', style: { right: 5, top: 40, width: 12, height: 28 } },
  { muscle: 'glutes', style: { left: 20, top: 76, width: 34, height: 22 } },
  { muscle: 'hamstrings', style: { left: 18, top: 102, width: 17, height: 42 } },
  { muscle: 'lower_back', style: { right: 18, top: 102, width: 17, height: 42 } },
];

function BodyMap({ side, regions, selected, onSelect }: {
  side: 'front' | 'back';
  regions: RecoveryRegion[];
  selected: string;
  onSelect: (muscle: string) => void;
}) {
  const layout = side === 'front' ? FRONT_REGIONS : BACK_REGIONS;
  const byMuscle = new Map(regions.map((r) => [r.muscle, r]));

  return (
    <div>
      <div className="relative h-[184px] w-[74px] border border-line">
        <span aria-hidden="true" className="absolute inset-y-0 left-1/2 w-px bg-line-10" />
        {/* Head */}
        <span
          aria-hidden="true"
          className="absolute border border-line-strong"
          style={{ left: 29, top: 5, width: 16, height: 15 }}
        />
        {layout.map((r) => {
          const data = byMuscle.get(r.muscle);
          // Fill encodes outstanding recovery: the more it is still recovering,
          // the more it is filled in.
          const outstanding = data ? (100 - data.recoveredPct) / 100 : 0;
          const active = selected === r.muscle;
          return (
            <button
              key={r.muscle}
              type="button"
              aria-label={
                data
                  ? `${data.label}, ${data.recoveredPct}% recovered`
                  : r.muscle.replace(/_/g, ' ')
              }
              aria-pressed={active}
              onClick={() => data && onSelect(r.muscle)}
              disabled={!data}
              className={cx(
                'absolute border p-0',
                active ? 'border-sonar' : 'border-line-strong',
                data ? 'cursor-pointer' : 'cursor-default opacity-40',
              )}
              style={{
                ...r.style,
                background: `rgba(70,200,221,${(0.06 + outstanding * 0.62).toFixed(2)})`,
              }}
            />
          );
        })}
      </div>
      <div className="mt-1 text-center font-utility text-[9px] uppercase tracking-[0.1em] text-foam-35">{side}</div>
    </div>
  );
}

function ProgressSkeleton() {
  return (
    <ScreenBody>
      <Stack>
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-9 w-52" />
        <Skeleton className="h-44 w-full" />
        <Skeleton className="h-56 w-full" />
        <Skeleton className="h-32 w-full" />
      </Stack>
    </ScreenBody>
  );
}
