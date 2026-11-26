import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { MuscleGroup } from '@shark/contracts';
import { MUSCLE_LABEL } from '@shark/domain';
import { api } from '../../lib/api';
import { Button, Chip, Display, EmptyState, ErrorState, Label, Skeleton, cx } from '../../ui/primitives';

/**
 * Build a session from the exercise library (P05, PF-WORK-004).
 *
 * The library is kept on the phone after the first load, so a member in a
 * basement with no signal can still put a session together; logging itself
 * never needs the network (same logger, same outbox as a coached session).
 */

export interface LibraryExercise {
  id: string;
  name: string;
  aliases: string[];
  equipment: string;
  usesBarbell: boolean;
  primaryMuscles: MuscleGroup[];
  secondaryMuscles: MuscleGroup[];
  defaultRestSec: number;
  lastPerformance: { weightKg: number; reps: number; label: string } | null;
}

const LIBRARY_KEY = 'shark.exercise.library';
export const MAX_FREESTYLE_EXERCISES = 12;

function cachedLibrary(): LibraryExercise[] | null {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    return raw ? (JSON.parse(raw) as LibraryExercise[]) : null;
  } catch {
    return null;
  }
}

export function FreestylePicker({ onStart, onCancel }: { onStart: (picked: LibraryExercise[]) => void; onCancel: () => void }) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const library = useQuery({
    queryKey: ['training', 'exercises'],
    queryFn: async () => {
      const { items } = await api<{ items: LibraryExercise[] }>('/member/training/exercises');
      try {
        localStorage.setItem(LIBRARY_KEY, JSON.stringify(items));
      } catch {
        /* private mode: the session still works while this screen is open */
      }
      return items;
    },
    staleTime: 10 * 60_000,
    retry: false,
  });
  const items = library.data ?? (library.isError ? cachedLibrary() : null);

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!items) return [];
    if (!term) return items;
    return items.filter(
      (e) =>
        e.name.toLowerCase().includes(term) ||
        e.aliases.some((a) => a.toLowerCase().includes(term)) ||
        e.primaryMuscles.some((m) => (MUSCLE_LABEL[m] ?? m).toLowerCase().includes(term)),
    );
  }, [items, query]);

  const toggle = (id: string) =>
    setPicked((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : current.length >= MAX_FREESTYLE_EXERCISES ? current : [...current, id],
    );

  const start = () => {
    if (!items) return;
    const byId = new Map(items.map((e) => [e.id, e]));
    onStart(picked.map((id) => byId.get(id)!).filter(Boolean));
  };

  return (
    <div className="flex flex-col gap-3.5 p-4">
      <div>
        <Label>Log a workout</Label>
        <Display size="md" as="h1" className="mt-1">
          Build your session
        </Display>
        <p className="mt-1.5 text-[13px] leading-relaxed text-foam-65">
          Pick the exercises, in the order you will do them. Each starts with three sets you can change, add to or skip. Sets save on
          this phone as you go and sync when there is signal.
        </p>
      </div>

      {library.isLoading && !items ? (
        <div className="flex flex-col gap-2" aria-label="Loading the exercise library">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : !items ? (
        <ErrorState
          title="The exercise library needs a connection the first time"
          body="Once it has loaded on this phone it works offline. Anything you have already logged is safe."
          onRetry={() => void library.refetch()}
        />
      ) : (
        <>
          {library.isError ? <p className="text-[12px] text-foam-65">Offline: showing the library saved on this phone.</p> : null}
          <label className="flex flex-col gap-1.5 text-[12px] text-foam-65">
            Search
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Squat, row, chest…"
              className="min-h-11 border border-line bg-transparent px-3 text-[14px] text-foam"
            />
          </label>
          {visible.length === 0 ? (
            <EmptyState title="Nothing matches" body="Try another name, or a muscle such as glutes or lats." />
          ) : (
            <ul className="flex flex-col border border-line" aria-label="Exercise library">
              {visible.map((exercise) => {
                const position = picked.indexOf(exercise.id);
                const selected = position >= 0;
                return (
                  <li key={exercise.id} className="border-b border-line-10 last:border-b-0">
                    <button
                      type="button"
                      aria-pressed={selected}
                      aria-label={selected ? `${exercise.name}, number ${position + 1}` : exercise.name}
                      aria-describedby={`ex-detail-${exercise.id}`}
                      onClick={() => toggle(exercise.id)}
                      disabled={!selected && picked.length >= MAX_FREESTYLE_EXERCISES}
                      className={cx('flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left', selected && 'bg-wash-sonar')}
                    >
                      <span
                        aria-hidden="true"
                        className={cx('grid h-7 w-7 flex-none place-items-center border font-display text-[13px]', selected ? 'border-sonar text-sonar' : 'border-line text-foam-45')}
                      >
                        {selected ? position + 1 : '+'}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px]">{exercise.name}</span>
                        <span id={`ex-detail-${exercise.id}`} className="block truncate text-[11px] text-foam-50">
                          {exercise.primaryMuscles.map((m) => MUSCLE_LABEL[m] ?? m).join(', ')} · {exercise.equipment}
                          {exercise.lastPerformance ? ` · last ${exercise.lastPerformance.label}` : ''}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      <div className="sticky bottom-0 flex gap-2.5 bg-overlay/90 py-2">
        <Button variant="cta" size="lg" className="flex-1" disabled={picked.length === 0} onClick={start}>
          {picked.length === 0 ? 'Pick at least one' : `Start · ${picked.length} ${picked.length === 1 ? 'exercise' : 'exercises'}`}
        </Button>
        <Button variant="outline" size="lg" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {picked.length >= MAX_FREESTYLE_EXERCISES ? (
        <Chip tone="warn" glyph={false}>
          {MAX_FREESTYLE_EXERCISES} is the most in one session
        </Chip>
      ) : null}
    </div>
  );
}
