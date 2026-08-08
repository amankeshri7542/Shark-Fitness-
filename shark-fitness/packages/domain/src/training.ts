import type { MuscleGroup } from '@shark/contracts';

/* ============================================================================
   Strength maths
   ========================================================================= */

/** Epley, capped at 12 reps. Beyond that the estimate stops meaning anything
 *  and we say so rather than drawing a confident wrong line. */
export function estimate1rm(weightKg: number, reps: number): number | null {
  if (weightKg <= 0 || reps <= 0) return null;
  if (reps === 1) return weightKg;
  if (reps > 12) return null;
  return Math.round(weightKg * (1 + reps / 30) * 10) / 10;
}

export const MUSCLE_LABEL: Record<MuscleGroup, string> = {
  chest: 'Chest',
  front_delt: 'Front delt',
  side_delt: 'Side delt',
  rear_delt: 'Rear delt',
  lats: 'Lats',
  traps: 'Traps',
  upper_back: 'Upper back',
  lower_back: 'Lower back',
  biceps: 'Biceps',
  triceps: 'Triceps',
  forearms: 'Forearms',
  core: 'Core',
  glutes: 'Glutes',
  quads: 'Quads',
  hamstrings: 'Hamstrings',
  calves: 'Calves',
  cardio: 'Cardio',
};

/**
 * Plate maths for one side of a 20 kg bar. Returns null when the target is not
 * loadable — telling someone "2.5 + 1.25" for a weight the gym cannot make is
 * worse than telling them it does not fit.
 */
export const PLATES_KG = [25, 20, 15, 10, 5, 2.5, 1.25] as const;

export function platesPerSide(
  totalKg: number,
  barKg = 20,
  available: readonly number[] = PLATES_KG,
): { plates: number[]; label: string } | null {
  if (totalKg < barKg) return null;
  let side = (totalKg - barKg) / 2;
  if (side === 0) return { plates: [], label: 'bar only' };
  const plates: number[] = [];
  for (const p of available) {
    while (side >= p - 0.001) {
      plates.push(p);
      side = Math.round((side - p) * 100) / 100;
    }
  }
  if (side > 0.001) return null;
  return { plates, label: plates.join(' + ') };
}

/** Smallest increment the gym can actually make on a barbell. */
export function roundToLoadable(kg: number, stepKg = 2.5): number {
  return Math.round(kg / stepKg) * stepKg;
}

/* ============================================================================
   Recovery model

   An estimate from logged sets and elapsed time, nothing more. Labelled as an
   estimate everywhere it surfaces — it is not a medical measure (PF-PROG-005).
   ========================================================================= */

/** Hours to nominal full recovery, by muscle size. Larger groups take longer. */
const RECOVERY_HOURS: Record<MuscleGroup, number> = {
  chest: 72,
  front_delt: 48,
  side_delt: 48,
  rear_delt: 48,
  lats: 72,
  traps: 48,
  upper_back: 72,
  lower_back: 96,
  biceps: 48,
  triceps: 48,
  forearms: 36,
  core: 48,
  glutes: 72,
  quads: 96,
  hamstrings: 96,
  calves: 36,
  cardio: 24,
};

/** Sets that count as a full stimulus for that group. Beyond this, more sets
 *  do not extend recovery further in this model. */
const FULL_STIMULUS_SETS = 12;

export interface MuscleLoad {
  muscle: MuscleGroup;
  /** Direct sets count 1.0, indirect (secondary mover) count 0.5. */
  weightedSets: number;
  hoursSince: number;
}

export function recoveryPct(load: MuscleLoad): number {
  const nominal = RECOVERY_HOURS[load.muscle];
  const intensity = Math.min(1, load.weightedSets / FULL_STIMULUS_SETS);
  if (intensity <= 0) return 100;
  const needed = nominal * intensity;
  if (needed <= 0) return 100;
  const pct = Math.min(1, load.hoursSince / needed);
  // Ease-out: the last stretch of recovery is slower than linear.
  const eased = 1 - Math.pow(1 - pct, 1.5);
  return Math.max(0, Math.min(100, Math.round(eased * 100)));
}

export function recoveryNote(muscle: MuscleGroup, pct: number, setsLast7d: number): string {
  const label = MUSCLE_LABEL[muscle];
  if (setsLast7d === 0) return `No direct work logged this week. ${label} is ready.`;
  if (pct >= 90) return `Recovered. ${setsLast7d} ${setsLast7d === 1 ? 'set' : 'sets'} in the last seven days.`;
  if (pct >= 65) return `Most of the way back. Light work is fine.`;
  if (pct >= 35) return `Still recovering. Give it another day before heavy work.`;
  return `Worked hard recently. Heavy loading here today is not a good idea.`;
}

/** Weekly volume landmarks. Used to flag a jump, never to shame a low week. */
export function volumeWarning(thisWeekSets: number, lastWeekSets: number): string | null {
  if (lastWeekSets < 4) return null;
  const jump = (thisWeekSets - lastWeekSets) / lastWeekSets;
  if (jump > 0.6) {
    return `That is a big step up from last week (${lastWeekSets} to ${thisWeekSets} sets). Increases above about 20% a week tend to cost more than they give.`;
  }
  return null;
}

/* ============================================================================
   Adaptive engine — deterministic, versioned, explainable (PF-AI-001/003).

   Rules only. A generative model never decides a load here; it may only be
   asked to rephrase the explanation this function already produced.
   ========================================================================= */

export const RULES_VERSION = 'v4.2';

export interface AdaptiveInput {
  exerciseId: string;
  exerciseName: string;
  /** Most recent first. */
  history: Array<{ topSetKg: number; reps: number; rpe: number | null; hitAllSets: boolean; at: string }>;
  prescribedKg: number;
  repLow: number;
  repHigh: number;
  targetRpe: number;
  loadStepKg: number;
  trainerLocked: boolean;
  /** Recovery for the primary mover, 0–100. */
  recoveredPct: number;
  daysSinceLastSession: number;
  reportedInjury: boolean;
}

export interface AdaptiveChange {
  exerciseName: string;
  field: string;
  from: string;
  to: string;
}

export interface AdaptiveResult {
  rulesVersion: string;
  newLoadKg: number;
  changed: boolean;
  headline: string;
  explanation: string;
  inputs: string[];
  changes: AdaptiveChange[];
  confidence: 'low' | 'medium' | 'high';
  limitations: string;
  requiresTrainerReview: boolean;
}

export function adaptLoad(i: AdaptiveInput): AdaptiveResult {
  const inputs = [
    `last ${Math.min(i.history.length, 3)} ${i.exerciseName} sessions`,
    'logged RPE',
    'set completion',
    `recovery estimate (${i.recoveredPct}%)`,
  ];
  const base = {
    rulesVersion: RULES_VERSION,
    inputs,
    limitations:
      'Estimates from what you logged. They do not know how you slept, ate or feel. Tell your coach if anything hurts.',
  };

  // Safety gates come first and are never overridden by progression rules.
  if (i.reportedInjury) {
    return {
      ...base,
      newLoadKg: i.prescribedKg,
      changed: false,
      headline: 'Load held while you are carrying an injury',
      explanation:
        'You flagged an injury, so nothing was increased. Your coach will look at this before the next block.',
      changes: [],
      confidence: 'high',
      requiresTrainerReview: true,
    };
  }

  if (i.trainerLocked) {
    return {
      ...base,
      newLoadKg: i.prescribedKg,
      changed: false,
      headline: 'Your coach has locked this exercise',
      explanation: 'The prescription stays as written until your coach changes it.',
      changes: [],
      confidence: 'high',
      requiresTrainerReview: false,
    };
  }

  const recent = i.history.slice(0, 3);
  if (recent.length === 0) {
    return {
      ...base,
      newLoadKg: i.prescribedKg,
      changed: false,
      headline: 'First time on this lift',
      explanation: 'Start at the prescribed load and log your RPE so the next session can adjust.',
      changes: [],
      confidence: 'low',
      requiresTrainerReview: false,
    };
  }

  const last = recent[0]!;
  const easySessions = recent.filter((h) => (h.rpe ?? 10) <= i.targetRpe - 1 && h.hitAllSets).length;
  const hardMisses = recent.filter((h) => (h.rpe ?? 0) >= i.targetRpe + 1 || !h.hitAllSets).length;

  let newLoad = i.prescribedKg;
  let headline = 'No change this week';
  let explanation = 'Recent sessions landed on target, so the prescription holds.';
  let confidence: 'low' | 'medium' | 'high' = 'medium';
  let review = false;

  if (i.recoveredPct < 40) {
    newLoad = roundToLoadable(i.prescribedKg - i.loadStepKg, i.loadStepKg);
    headline = 'Load eased back while you recover';
    explanation = `The muscles this lift uses are about ${i.recoveredPct}% recovered. Load dropped one step to ${newLoad} kg.`;
    confidence = 'medium';
  } else if (easySessions >= 2 && last.reps >= i.repHigh) {
    newLoad = roundToLoadable(i.prescribedKg + i.loadStepKg, i.loadStepKg);
    headline = `Top set moved ${i.prescribedKg} → ${newLoad} kg`;
    explanation = `Two sessions at RPE ${i.targetRpe - 1} or lower with every set completed, and you hit the top of the rep range. One step up.`;
    confidence = 'high';
  } else if (hardMisses >= 2) {
    newLoad = roundToLoadable(i.prescribedKg - i.loadStepKg, i.loadStepKg);
    headline = `Top set eased ${i.prescribedKg} → ${newLoad} kg`;
    explanation = `The last two sessions came in above the target RPE or missed sets. Backing off one step keeps the reps clean.`;
    confidence = 'high';
    review = true;
  } else if (i.daysSinceLastSession > 14) {
    newLoad = roundToLoadable(i.prescribedKg * 0.9, i.loadStepKg);
    headline = 'Load reset after a break';
    explanation = `It has been ${i.daysSinceLastSession} days. Starting at ${newLoad} kg for one session, then back to normal progression.`;
    confidence = 'medium';
  }

  const changed = newLoad !== i.prescribedKg;
  return {
    ...base,
    newLoadKg: newLoad,
    changed,
    headline,
    explanation,
    changes: changed
      ? [
          {
            exerciseName: i.exerciseName,
            field: 'Top set load',
            from: `${i.prescribedKg} kg`,
            to: `${newLoad} kg`,
          },
        ]
      : [],
    confidence,
    requiresTrainerReview: review,
  };
}

/* ============================================================================
   Session maths
   ========================================================================= */

export function sessionVolumeKg(sets: Array<{ weightKg: number; reps: number; isWarmup: boolean }>): number {
  return Math.round(
    sets.filter((s) => !s.isWarmup).reduce((total, s) => total + s.weightKg * s.reps, 0),
  );
}

export function muscleShare(
  sets: Array<{ primary: MuscleGroup[]; secondary: MuscleGroup[] }>,
): Array<{ muscle: MuscleGroup; sets: number; share: number }> {
  const tally = new Map<MuscleGroup, number>();
  for (const s of sets) {
    for (const m of s.primary) tally.set(m, (tally.get(m) ?? 0) + 1);
    for (const m of s.secondary) tally.set(m, (tally.get(m) ?? 0) + 0.5);
  }
  const max = Math.max(1, ...tally.values());
  return [...tally.entries()]
    .map(([muscle, count]) => ({ muscle, sets: Math.round(count), share: count / max }))
    .sort((a, b) => b.share - a.share);
}
