import { Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useCopy } from '../lib/store';
import { ScreenBody, Stack, Surface } from '../ui/shell';
import {
  Bar,
  Button,
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

interface PlanDay {
  dayIndex: number;
  dayName: string;
  date: string;
  programDayId: string;
  label: string;
  focus: string;
  isRest: boolean;
  estimatedMin: number;
  exerciseCount: number;
  setCount: number;
  state: 'done' | 'planned' | 'today' | 'rest' | string;
  isToday: boolean;
  past: boolean;
  completed: { volumeKg: number; durationSec: number } | null;
}

interface PlanItem {
  id: string;
  exerciseId: string;
  exerciseName: string;
  equipment: string;
  muscleLabels: string[];
  usesBarbell: boolean;
  targetLabel: string;
  targetKg: number | null;
  plateLabel: string | null;
  restSec: number;
  supersetGroup: string | null;
  rationale: string | null;
  trainerLocked: boolean;
  lastPerformance: { label: string; atLabel: string } | null;
  recovery: { label: string; recoveredPct: number; note: string } | null;
  adaptive: { changed: boolean; headline: string; explanation: string; newLoadKg: number } | null;
}

interface PlanPayload {
  assignment: { id: string; currentWeek: number; currentBlock: string; trainerName: string | null } | null;
  program: { name: string; version: number; goal: string; daysPerWeek: number; weeks: number; description: string } | null;
  week: {
    number: number;
    of: number;
    block: string;
    days: PlanDay[];
    setsThisWeek: number;
    setsLastWeek: number;
    volumeWarning: string | null;
  } | null;
  today: {
    programDayId: string | null;
    label: string;
    focus: string;
    isRest: boolean;
    estimatedMin: number;
    done: boolean;
    items: PlanItem[];
  } | null;
  explanation: {
    decisionId: string;
    headline: string;
    body: string;
    inputs: string[];
    changes: Array<{ exerciseName: string; field: string; from: string; to: string }>;
    confidence: string;
    limitations: string;
    rulesVersion: string;
    reviewedByName: string | null;
    reviewedAt: string | null;
  } | null;
}

export default function TrainScreen() {
  const copy = useCopy();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['plan'],
    queryFn: () => api<PlanPayload>('/member/training/plan'),
  });

  const decide = useMutation({
    mutationFn: (input: { id: string; decision: 'accepted' | 'declined' }) =>
      api(`/member/training/adaptive/${input.id}/decision`, {
        method: 'POST',
        body: { decision: input.decision },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['plan'] });
      void queryClient.invalidateQueries({ queryKey: ['home'] });
    },
  });

  if (isLoading) return <TrainSkeleton />;

  if (error || !data) {
    return (
      <ScreenBody>
        <Stack>
          <ErrorState
            title="Could not load your plan"
            body="Your logged sessions are safe. Try again in a moment."
            onRetry={() => void refetch()}
          />
        </Stack>
      </ScreenBody>
    );
  }

  if (!data.assignment || !data.week || !data.today) {
    return (
      <ScreenBody>
        <Stack>
          <Display size="lg">Train</Display>
          <EmptyState
            title="No plan assigned yet"
            body="A coach builds your programme around your goals, your schedule and the kit you actually have. Ask for one, or log a session yourself from the exercise library."
            action={
              <div className="flex gap-2.5">
                <Link to="/messages">
                  <Button variant="cta" size="sm">
                    Ask for a plan
                  </Button>
                </Link>
                <Button variant="outline" size="sm" onClick={() => void navigate({ to: '/workout' })}>
                  Log a session
                </Button>
              </div>
            }
          />
        </Stack>
      </ScreenBody>
    );
  }

  const { week, today, explanation } = data;

  return (
    <ScreenBody>
      <Surface>
        <Stack>
          <div>
            <Eyebrow>
              Assigned programme · v{data.program?.version}
            </Eyebrow>
            <Display size="lg" className="mt-1.5">
              {data.program?.name}
            </Display>
            <p className="mt-1.5 text-[12px] text-foam-50">
              {data.assignment.trainerName ?? 'Self-directed'} · {data.program?.daysPerWeek} days a week · week{' '}
              {week.number} of {week.of}
            </p>
          </div>

          {/* Why the plan changed — inputs, rules version, reviewer, limits.
              An adaptive change that cannot explain itself does not ship. */}
          {explanation ? (
            <Panel tone="accent" className="p-3.5">
              <Eyebrow>Why this week changed</Eyebrow>
              <p className="mt-2 font-utility text-[15px] font-semibold leading-snug">{explanation.headline}</p>
              <p className="mt-1.5 text-[13px] leading-relaxed text-pretty text-foam-80">{explanation.body}</p>

              {explanation.changes.length > 0 ? (
                <div className="mt-3 border-t border-line pt-2.5">
                  {explanation.changes.map((change, i) => (
                    <div key={i} className="flex items-baseline gap-2 text-[12px]">
                      <span className="text-foam-50">{change.exerciseName}</span>
                      <span className="flex-1" />
                      <span className="text-foam-45 line-through">{change.from}</span>
                      <span aria-hidden="true" className="text-foam-35">
                        →
                      </span>
                      <span className="font-display text-[15px] text-sonar">{change.to}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              <p className="mt-2.5 border-t border-line pt-2.5 text-[11px] leading-relaxed text-foam-45">
                Inputs: {explanation.inputs.join(', ')}. Rule set {explanation.rulesVersion}. Confidence{' '}
                {explanation.confidence}.
                {explanation.reviewedByName ? ` Reviewed by ${explanation.reviewedByName}.` : ''}
              </p>
              <p className="mt-1.5 text-[11px] leading-relaxed text-foam-45">{explanation.limitations}</p>

              <div className="mt-3 flex gap-2">
                <Button
                  variant="cta"
                  size="sm"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ id: explanation.decisionId, decision: 'accepted' })}
                >
                  Use it
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ id: explanation.decisionId, decision: 'declined' })}
                >
                  Keep the old load
                </Button>
                <Link to="/messages" className="ml-auto">
                  <Button variant="ghost" size="sm">
                    Ask coach
                  </Button>
                </Link>
              </div>
            </Panel>
          ) : null}

          {week.volumeWarning ? (
            <Panel tone="warn" className="p-3.5">
              <Label className="text-flare">Worth knowing</Label>
              <p className="mt-1.5 text-[13px] leading-relaxed text-foam-80">{week.volumeWarning}</p>
            </Panel>
          ) : null}

          <Seam>
            <SeamCell>
              <Label>Week</Label>
              <div className="mt-1.5">
                <Metric value={`${week.number}/${week.of}`} size="md" />
              </div>
            </SeamCell>
            <SeamCell>
              <Label>Block</Label>
              <div className="mt-1.5">
                <Metric value={week.block} size="md" tone="accent" />
              </div>
            </SeamCell>
            <SeamCell>
              <Label>Sets this week</Label>
              <div className="mt-1.5">
                <Metric value={week.setsThisWeek} size="md" />
              </div>
              <p className="mt-1 text-[11px] text-foam-45">was {week.setsLastWeek}</p>
            </SeamCell>
          </Seam>

          <div>
            <SectionRule>This week</SectionRule>
            <Panel>
              {week.days.map((day) => (
                <div
                  key={day.programDayId || day.date}
                  className={cx(
                    'flex items-center gap-3 border-b border-line-10 px-3 py-3 last:border-0',
                    day.isToday && 'bg-wash-sonar',
                    day.past && day.state === 'done' && 'opacity-55',
                  )}
                >
                  <span
                    className={cx(
                      'w-9 flex-none font-utility text-[11px] font-semibold uppercase tracking-[0.1em]',
                      day.isToday ? 'text-sonar' : 'text-foam-45',
                    )}
                  >
                    {day.dayName}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className={cx('truncate text-[14px]', day.isRest && 'text-foam-50')}>{day.label}</div>
                    {!day.isRest ? (
                      <div className="mt-0.5 font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
                        {day.exerciseCount} exercises · {day.setCount} sets · ~{day.estimatedMin} min
                      </div>
                    ) : null}
                  </div>
                  {day.isToday && !day.isRest && !day.completed ? (
                    <Button variant="cta" size="sm" onClick={() => void navigate({ to: '/workout' })}>
                      {copy('startSession')}
                    </Button>
                  ) : day.state === 'done' || day.completed ? (
                    <Chip tone="good">Done</Chip>
                  ) : day.isRest ? (
                    <Chip tone="neutral" glyph={false}>
                      Rest
                    </Chip>
                  ) : (
                    <Chip tone="neutral" glyph={false}>
                      Planned
                    </Chip>
                  )}
                </div>
              ))}
            </Panel>
          </div>

          <div>
            <SectionRule>{today.isRest ? "Today's rest day" : "Today's exercises"}</SectionRule>

            {today.isRest ? (
              <EmptyState
                title="Rest day"
                body="Nothing scheduled. Recovery is when the work you already did turns into progress — come in for mobility if you want to move."
                action={
                  <Link to="/habits">
                    <Button variant="outline" size="sm">
                      Log today's habits
                    </Button>
                  </Link>
                }
              />
            ) : (
              <div className="flex flex-col gap-2">
                {today.items.map((item, index) => (
                  <Link
                    key={item.id}
                    to="/train/exercise/$exerciseId"
                    params={{ exerciseId: item.exerciseId }}
                    className="block"
                  >
                    <Panel className="p-3 hover:border-line-strong">
                      <div className="flex items-start gap-3">
                        <span className="w-4 flex-none font-display text-[13px] text-foam-35">{index + 1}</span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate font-utility text-[15px] font-semibold">{item.exerciseName}</span>
                            {item.trainerLocked ? (
                              <Chip tone="warn" glyph={false}>
                                Locked
                              </Chip>
                            ) : null}
                            {item.supersetGroup ? (
                              <Chip tone="accent" glyph={false}>
                                Superset {item.supersetGroup}
                              </Chip>
                            ) : null}
                          </div>
                          <div className="mt-1 text-[12px] text-foam-50">
                            {item.targetLabel}
                            {item.targetKg ? ` · ${item.targetKg} kg` : ''}
                          </div>
                          {item.muscleLabels.length > 0 ? (
                            <div className="mt-1 font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
                              {item.muscleLabels.join(' · ')}
                            </div>
                          ) : null}
                        </div>
                        <div className="flex-none text-right">
                          {item.lastPerformance ? (
                            <>
                              <div className="font-display text-[14px] tabular-nums">{item.lastPerformance.label}</div>
                              <div className="mt-0.5 font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
                                {item.lastPerformance.atLabel}
                              </div>
                            </>
                          ) : (
                            <span className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
                              First time
                            </span>
                          )}
                        </div>
                      </div>

                      {item.recovery ? (
                        <div className="mt-2.5 flex items-center gap-2 border-t border-line-10 pt-2.5">
                          <span className="w-[68px] flex-none font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
                            {item.recovery.label}
                          </span>
                          <Bar
                            value={item.recovery.recoveredPct}
                            className="flex-1"
                            height="h-1.5"
                            tone={item.recovery.recoveredPct < 45 ? 'warn' : 'accent'}
                          />
                          <span className="w-9 flex-none text-right font-display text-[12px] tabular-nums">
                            {item.recovery.recoveredPct}%
                          </span>
                        </div>
                      ) : null}
                    </Panel>
                  </Link>
                ))}

                <Button variant="cta" size="lg" full className="mt-1.5" onClick={() => void navigate({ to: '/workout' })}>
                  {today.done ? 'Log another session' : copy('startSession')}
                </Button>
              </div>
            )}
          </div>
        </Stack>
      </Surface>
    </ScreenBody>
  );
}

function TrainSkeleton() {
  return (
    <ScreenBody>
      <Stack>
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-56 w-full" />
      </Stack>
    </ScreenBody>
  );
}
