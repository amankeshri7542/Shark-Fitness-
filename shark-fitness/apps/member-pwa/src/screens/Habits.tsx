import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api';
import { enqueue } from '../lib/outbox';
import { useCopy } from '../lib/store';
import { ScreenBody, Stack } from '../ui/shell';
import {
  Bar,
  Button,
  Chip,
  Display,
  EmptyState,
  ErrorState,
  Label,
  Metric,
  Panel,
  Seam,
  SeamCell,
  SectionRule,
  Skeleton,
  cx,
} from '../ui/primitives';

/**
 * Habits and daily metrics.
 *
 * Ticking a habit happens on a gym floor with bad signal, so every write goes
 * through the offline outbox rather than a bare fetch: the tick lands locally
 * and syncs when it can. The `clientId` is the idempotency key, so a retry
 * cannot double-log a day.
 *
 * Nutrition copy stays plain — it is health guidance, and the disclaimer the
 * server sends is rendered verbatim rather than paraphrased.
 */

interface HabitView {
  id: string;
  name: string;
  icon: string;
  cadence: string;
  target: number;
  unit: string;
  active: boolean;
  todayValue: number;
  done: boolean;
  streakDays: number;
  longestStreak: number;
  last7Days: Array<{ date: string; label: string; done: boolean; value: number }>;
}

interface Payload {
  today: { date: string; label: string };
  optedOut: boolean;
  habits: HabitView[];
  summary: { total: number; doneToday: number; bestStreak: number };
  metrics: {
    waterMl: number;
    waterTargetMl: number;
    sleepMin: number | null;
    steps: number | null;
    mood: number | null;
    energy: number | null;
    soreness: number | null;
    logged: boolean;
  };
  nutrition: {
    enabled: boolean;
    kcal: number | null;
    proteinG: number | null;
    waterTargetMl: number;
    setByName: string | null;
    disclaimer: string;
  };
  coach: { name: string | null } | null;
}

const GLASS_ML = 250;

export default function HabitsScreen() {
  const copy = useCopy();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<Record<string, number>>({});

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['habits'],
    queryFn: () => api<Payload>('/member/habits'),
  });

  /** Optimistic locally, queued for the server. The screen must respond on a
   *  dead network, so the value shown is the local one until a refetch wins. */
  const logHabit = (habit: HabitView, value: number): void => {
    if (!data) return;
    setPending((p) => ({ ...p, [habit.id]: value }));
    void enqueue({
      clientId: `habit:${habit.id}:${data.today.date}:${value}`,
      kind: 'habit-log',
      method: 'POST',
      path: '/member/habits/log',
      body: {
        habitId: habit.id,
        onDate: data.today.date,
        value,
        clientId: `habit:${habit.id}:${data.today.date}:${value}`,
      },
    }).then(() => {
      void queryClient.invalidateQueries({ queryKey: ['habits'] });
      void queryClient.invalidateQueries({ queryKey: ['home'] });
    });
  };

  const logWater = (waterMl: number): void => {
    if (!data) return;
    setPending((p) => ({ ...p, water: waterMl }));
    void enqueue({
      clientId: `metrics:${data.today.date}:water:${waterMl}`,
      kind: 'habit-metrics',
      method: 'POST',
      path: '/member/habits/metrics',
      body: { onDate: data.today.date, waterMl, source: 'manual' },
    }).then(() => void queryClient.invalidateQueries({ queryKey: ['habits'] }));
  };

  if (isLoading) {
    return (
      <ScreenBody>
        <Stack>
          <Skeleton className="h-20" />
          <Skeleton className="h-16" />
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </Stack>
      </ScreenBody>
    );
  }

  if (error || !data) {
    return (
      <ScreenBody>
        <Stack>
          <ErrorState
            title="Could not load your habits"
            body="Anything you ticked offline is still queued and will sync. Try again in a moment."
            onRetry={() => void refetch()}
            requestId={error instanceof ApiError ? error.requestId : undefined}
          />
        </Stack>
      </ScreenBody>
    );
  }

  if (data.optedOut) {
    return (
      <ScreenBody>
        <Stack>
          <EmptyState
            title="Habits are switched off"
            body="You opted out of habit tracking. Reception or your coach can turn it back on whenever you want it."
          />
        </Stack>
      </ScreenBody>
    );
  }

  const water = pending.water ?? data.metrics.waterMl;
  const waterTarget = Math.max(1, data.metrics.waterTargetMl);

  return (
    <ScreenBody>
      <Stack>
        <div>
          <Label>{data.today.label}</Label>
          <Display size="md" as="h1" className="mt-1">
            {data.summary.doneToday} of {data.summary.total} done
          </Display>
        </div>

        <Seam>
          <SeamCell>
            <Label>Done today</Label>
            <div className="mt-1">
              <Metric value={data.summary.doneToday} size="md" tone="accent" />
            </div>
          </SeamCell>
          <SeamCell>
            <Label>Best streak</Label>
            <div className="mt-1">
              <Metric value={data.summary.bestStreak} unit="d" size="md" />
            </div>
          </SeamCell>
          <SeamCell>
            <Label>Water</Label>
            <div className="mt-1">
              <Metric value={Math.round(water / 100) / 10} unit="L" size="md" tone={water >= waterTarget ? 'good' : 'default'} />
            </div>
          </SeamCell>
        </Seam>

        {/* — Habits ————————————————————————————————————————— */}

        <SectionRule>{copy('streakLabel')}</SectionRule>

        {data.habits.length === 0 ? (
          <EmptyState
            title="No habits yet"
            body="Your coach sets these up with you. Ask them for one to start — a single daily habit is enough."
          />
        ) : (
          data.habits.map((habit) => {
            const value = pending[habit.id] ?? habit.todayValue;
            const done = value >= habit.target;
            return (
              <Panel key={habit.id} tone={done ? 'good' : 'plain'} className="flex flex-col gap-3 p-4">
                <div className="flex items-center gap-3">
                  <span aria-hidden="true" className="font-display text-[20px]">
                    {habit.icon}
                  </span>
                  <div className="min-w-0 flex-1">
                    <Display size="sm" as="h3">
                      {habit.name}
                    </Display>
                    <p className="mt-0.5 font-utility text-[10px] uppercase tracking-[0.12em] text-foam-45">
                      {habit.target} {habit.unit} · {habit.cadence}
                    </p>
                  </div>
                  {habit.streakDays > 0 ? <Chip tone="accent">{habit.streakDays}d</Chip> : null}
                </div>

                {/* The last seven days, so a missed day is visible without a chart. */}
                <div className="flex items-center gap-1.5">
                  {habit.last7Days.map((day) => (
                    <div key={day.date} className="flex flex-1 flex-col items-center gap-1">
                      <span
                        aria-hidden="true"
                        className={cx('h-6 w-full border', day.done ? 'border-kelp bg-kelp/30' : 'border-line')}
                      />
                      <span className="font-utility text-[9px] uppercase tracking-[0.1em] text-foam-35">{day.label}</span>
                    </div>
                  ))}
                </div>

                {habit.target === 1 ? (
                  <Button
                    variant={done ? 'outline' : 'cta'}
                    full
                    onClick={() => logHabit(habit, done ? 0 : 1)}
                    aria-pressed={done}
                  >
                    {done ? 'Done — undo' : 'Mark done'}
                  </Button>
                ) : (
                  <div className="flex flex-col gap-2">
                    <Bar value={value} max={habit.target} tone={done ? 'good' : 'accent'} />
                    <div className="flex items-center gap-2">
                      <span className="flex-1 font-utility text-[11px] uppercase tracking-[0.12em] text-foam-45">
                        {value} / {habit.target} {habit.unit}
                      </span>
                      <Button variant="outline" size="sm" onClick={() => logHabit(habit, Math.max(0, value - 1))}>
                        −1
                      </Button>
                      <Button variant="cta" size="sm" onClick={() => logHabit(habit, value + 1)}>
                        +1
                      </Button>
                    </div>
                  </div>
                )}
              </Panel>
            );
          })
        )}

        {/* — Water ——————————————————————————————————————————— */}

        <SectionRule>Water</SectionRule>
        <Panel className="flex flex-col gap-3 p-4">
          <Bar value={water} max={waterTarget} tone={water >= waterTarget ? 'good' : 'accent'} />
          <div className="flex items-center gap-2">
            <span className="flex-1 font-utility text-[11px] uppercase tracking-[0.12em] text-foam-45">
              {(water / 1000).toFixed(1)} of {(waterTarget / 1000).toFixed(1)} L
            </span>
            <Button variant="outline" size="sm" onClick={() => logWater(Math.max(0, water - GLASS_ML))}>
              − glass
            </Button>
            <Button variant="cta" size="sm" onClick={() => logWater(water + GLASS_ML)}>
              + glass
            </Button>
          </div>
        </Panel>

        {/* — Nutrition ——————————————————————————————————————— */}

        {data.nutrition.enabled ? (
          <>
            <SectionRule>Nutrition</SectionRule>
            <Panel className="flex flex-col gap-3 p-4">
              <Seam>
                <SeamCell>
                  <Label>Calories</Label>
                  <div className="mt-1">
                    <Metric value={data.nutrition.kcal ?? '—'} size="sm" />
                  </div>
                </SeamCell>
                <SeamCell>
                  <Label>Protein</Label>
                  <div className="mt-1">
                    <Metric value={data.nutrition.proteinG ?? '—'} unit="g" size="sm" />
                  </div>
                </SeamCell>
              </Seam>
              {data.nutrition.setByName ? (
                <p className="font-utility text-[10px] uppercase tracking-[0.12em] text-foam-35">
                  Set by {data.nutrition.setByName}
                </p>
              ) : null}
              {/* Rendered as sent. Health guidance is not ours to paraphrase. */}
              <p className="text-[12px] leading-relaxed text-foam-50">{data.nutrition.disclaimer}</p>
            </Panel>
          </>
        ) : null}
      </Stack>
    </ScreenBody>
  );
}
