import { useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api';
import { ScreenBody, Stack } from '../ui/shell';
import {
  Bar,
  Button,
  Chip,
  Display,
  ErrorState,
  Label,
  Panel,
  SectionRule,
  Skeleton,
} from '../ui/primitives';

/**
 * One exercise: how to do it, why it is in the plan, and what it is doing to
 * you right now.
 *
 * The safety-shaped parts stay plain register and come from the server
 * verbatim: contraindications, the coach's rationale, and the lock note when a
 * trainer has fixed the prescription. None of that is ours to reword.
 *
 * Video is optional by design. When it is missing the instructions and cues
 * carry the technique, and the screen says so rather than showing a dead frame.
 */

interface Payload {
  exercise: {
    id: string;
    name: string;
    equipment: string[];
    difficulty: string;
    primaryLabels: string[];
    secondaryLabels: string[];
    instructions: string[];
    cues: string[];
    contraindications: string[];
    isUnilateral: boolean;
    defaultRestSec: number;
  };
  media: { url: string | null; available: boolean; fallback: string };
  prescription: {
    sets: number;
    reps: string;
    loadKg: number | null;
    restSec: number;
    tempo: string | null;
  } | null;
  rationale: string | null;
  trainerLocked: boolean;
  lockNote: string | null;
  alternatives: Array<{ id: string; name: string; reason: string | null }>;
  canSubstitute: boolean;
  recovery: { label: string; recoveredPct: number; setsLast7d: number; note: string } | null;
  adaptive: { changed: boolean; headline: string; explanation: string } | null;
}

export default function ExerciseScreen() {
  const { exerciseId } = useParams({ from: '/tabs/train/exercise/$exerciseId' });
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['exercise', exerciseId],
    queryFn: () => api<Payload>(`/member/training/exercise/${exerciseId}`),
  });

  const substitute = useMutation({
    mutationFn: (toExerciseId: string) =>
      api('/member/training/substitute', { method: 'POST', body: { exerciseId, toExerciseId } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['exercise', exerciseId] });
      void queryClient.invalidateQueries({ queryKey: ['train'] });
    },
  });

  if (isLoading) {
    return (
      <ScreenBody>
        <Stack>
          <Skeleton className="h-32" />
          <Skeleton className="h-20" />
          <Skeleton className="h-40" />
        </Stack>
      </ScreenBody>
    );
  }

  if (error || !data) {
    return (
      <ScreenBody>
        <Stack>
          <ErrorState
            title="Could not load this exercise"
            body="Your plan is unchanged. Try again in a moment."
            onRetry={() => void refetch()}
            requestId={error instanceof ApiError ? error.requestId : undefined}
          />
        </Stack>
      </ScreenBody>
    );
  }

  const { exercise, media, prescription, recovery } = data;

  return (
    <ScreenBody>
      <Stack>
        <div>
          <Label>{exercise.primaryLabels.join(' · ') || 'Full body'}</Label>
          <Display size="md" as="h1" className="mt-1">
            {exercise.name}
          </Display>
          <div className="mt-2 flex flex-wrap gap-2">
            <Chip tone="neutral">{exercise.difficulty}</Chip>
            {exercise.equipment.map((item) => (
              <Chip key={item} tone="neutral">
                {item}
              </Chip>
            ))}
            {exercise.isUnilateral ? <Chip tone="accent">One side at a time</Chip> : null}
          </div>
        </div>

        {/* — Prescription ————————————————————————————————————— */}

        {prescription ? (
          <Panel tone="accent" className="flex flex-col gap-2 p-4">
            <Label>Today</Label>
            <p className="font-display text-[24px] leading-none">
              {prescription.sets} × {prescription.reps}
              {prescription.loadKg !== null ? ` @ ${prescription.loadKg} kg` : ''}
            </p>
            <p className="font-utility text-[10px] uppercase tracking-[0.12em] text-foam-45">
              Rest {prescription.restSec}s{prescription.tempo ? ` · tempo ${prescription.tempo}` : ''}
            </p>
          </Panel>
        ) : null}

        {data.adaptive?.changed ? (
          <Panel tone="warn" className="flex flex-col gap-1.5 p-4">
            <Label>{data.adaptive.headline}</Label>
            <p className="text-[13px] leading-relaxed text-foam-65">{data.adaptive.explanation}</p>
          </Panel>
        ) : null}

        {/* The coach's own words, never generated. */}
        {data.rationale ? (
          <Panel className="flex flex-col gap-1.5 p-4">
            <Label>Why this is in your plan</Label>
            <p className="text-[13px] leading-relaxed text-foam-65">{data.rationale}</p>
          </Panel>
        ) : null}

        {/* — Demonstration ——————————————————————————————————— */}

        {media.available && media.url ? (
          <video
            src={media.url}
            controls
            playsInline
            className="w-full border border-line"
            aria-label={`${exercise.name} demonstration`}
          />
        ) : (
          <Panel className="p-4">
            <p className="text-[13px] leading-relaxed text-foam-65">{media.fallback}</p>
          </Panel>
        )}

        {/* — Technique ————————————————————————————————————————— */}

        <SectionRule>How to do it</SectionRule>
        <Panel className="flex flex-col gap-2 p-4">
          <ol className="flex flex-col gap-2">
            {exercise.instructions.map((step, index) => (
              <li key={step} className="flex gap-3 text-[13px] leading-relaxed">
                <span className="font-display text-[15px] text-sonar">{index + 1}</span>
                <span className="text-foam-65">{step}</span>
              </li>
            ))}
          </ol>
        </Panel>

        {exercise.cues.length > 0 ? (
          <>
            <SectionRule>Cues</SectionRule>
            <Panel className="flex flex-col gap-1.5 p-4">
              {exercise.cues.map((cue) => (
                <p key={cue} className="text-[13px] leading-relaxed text-foam-65">
                  — {cue}
                </p>
              ))}
            </Panel>
          </>
        ) : null}

        {/* Safety copy is plain register and rendered as sent. */}
        {exercise.contraindications.length > 0 ? (
          <Panel tone="bad" className="flex flex-col gap-2 p-4">
            <Label>Skip this if</Label>
            {exercise.contraindications.map((item) => (
              <p key={item} className="text-[13px] leading-relaxed text-foam-65">
                — {item}
              </p>
            ))}
            <p className="mt-1 text-[12px] leading-relaxed text-foam-50">
              Tell your coach before you train around an injury. They can swap this for something that works.
            </p>
          </Panel>
        ) : null}

        {/* — Recovery ————————————————————————————————————————— */}

        {recovery ? (
          <>
            <SectionRule>{recovery.label}</SectionRule>
            <Panel className="flex flex-col gap-2 p-4">
              <Bar
                value={recovery.recoveredPct}
                max={100}
                tone={recovery.recoveredPct > 80 ? 'good' : recovery.recoveredPct > 50 ? 'warn' : 'bad'}
              />
              <p className="font-utility text-[10px] uppercase tracking-[0.12em] text-foam-45">
                {recovery.recoveredPct}% recovered · {recovery.setsLast7d} sets in 7 days
              </p>
              <p className="text-[13px] leading-relaxed text-foam-65">{recovery.note}</p>
            </Panel>
          </>
        ) : null}

        {/* — Swaps ————————————————————————————————————————————— */}

        {data.trainerLocked && data.lockNote ? (
          <Panel tone="warn" className="p-4">
            <Label>Locked by your coach</Label>
            <p className="mt-1 text-[13px] leading-relaxed text-foam-65">{data.lockNote}</p>
          </Panel>
        ) : data.canSubstitute && data.alternatives.length > 0 ? (
          <>
            <SectionRule>Swap it</SectionRule>
            <Panel className="flex flex-col gap-2 p-4">
              {data.alternatives.map((alt) => (
                <div key={alt.id} className="flex items-center gap-3 border-b border-line py-2 last:border-b-0">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px]">{alt.name}</p>
                    {alt.reason ? <p className="mt-0.5 text-[12px] text-foam-50">{alt.reason}</p> : null}
                  </div>
                  <Button variant="outline" size="sm" disabled={substitute.isPending} onClick={() => substitute.mutate(alt.id)}>
                    Use this
                  </Button>
                </div>
              ))}
            </Panel>
          </>
        ) : null}
      </Stack>
    </ScreenBody>
  );
}
