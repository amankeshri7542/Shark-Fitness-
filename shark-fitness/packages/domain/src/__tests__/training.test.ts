import { describe, expect, it } from 'vitest';
import {
  adaptLoad,
  estimate1rm,
  platesPerSide,
  recoveryPct,
  roundToLoadable,
  sessionVolumeKg,
  volumeWarning,
} from '../training.js';
import type { AdaptiveInput } from '../training.js';

describe('estimated 1RM', () => {
  it('returns the weight itself for a single', () => {
    expect(estimate1rm(100, 1)).toBe(100);
  });

  it('estimates with Epley for low reps', () => {
    expect(estimate1rm(60, 8)).toBe(76);
  });

  it('refuses to guess past 12 reps rather than drawing a confident wrong line', () => {
    expect(estimate1rm(60, 15)).toBeNull();
  });

  it('handles nonsense input without throwing', () => {
    expect(estimate1rm(0, 5)).toBeNull();
    expect(estimate1rm(60, 0)).toBeNull();
  });
});

describe('plate maths', () => {
  it('breaks a loadable weight into the fewest plates, heaviest first', () => {
    expect(platesPerSide(100)).toEqual({ plates: [25, 15], label: '25 + 15' });
    expect(platesPerSide(62.5)).toEqual({ plates: [20, 1.25], label: '20 + 1.25' });
    expect(platesPerSide(140)).toEqual({ plates: [25, 25, 10], label: '25 + 25 + 10' });
  });

  it('says bar only at bar weight', () => {
    expect(platesPerSide(20)).toEqual({ plates: [], label: 'bar only' });
  });

  it('returns null rather than lying about an unloadable weight', () => {
    expect(platesPerSide(21)).toBeNull();
    expect(platesPerSide(15)).toBeNull();
  });

  it('respects a gym that has no small plates', () => {
    expect(platesPerSide(62.5, 20, [20, 10, 5])).toBeNull();
    expect(platesPerSide(60, 20, [20, 10, 5])).toEqual({ plates: [20], label: '20' });
  });

  it('rounds to the nearest weight the gym can actually make', () => {
    expect(roundToLoadable(64)).toBe(65);
    expect(roundToLoadable(63.7)).toBe(62.5); // 62.5 is nearer than 65
    expect(roundToLoadable(61.2)).toBe(60);
  });
});

describe('recovery estimate', () => {
  it('reads fully recovered when nothing was worked', () => {
    expect(recoveryPct({ muscle: 'chest', weightedSets: 0, hoursSince: 2 })).toBe(100);
  });

  it('reads low right after a hard session and climbs with time', () => {
    const fresh = recoveryPct({ muscle: 'chest', weightedSets: 14, hoursSince: 2 });
    const later = recoveryPct({ muscle: 'chest', weightedSets: 14, hoursSince: 48 });
    const done = recoveryPct({ muscle: 'chest', weightedSets: 14, hoursSince: 96 });
    expect(fresh).toBeLessThan(20);
    expect(later).toBeGreaterThan(fresh);
    expect(done).toBe(100);
  });

  it('gives larger muscle groups longer', () => {
    const quads = recoveryPct({ muscle: 'quads', weightedSets: 12, hoursSince: 48 });
    const calves = recoveryPct({ muscle: 'calves', weightedSets: 12, hoursSince: 48 });
    expect(calves).toBeGreaterThan(quads);
  });
});

describe('volume warning', () => {
  it('flags a large week-on-week jump', () => {
    expect(volumeWarning(30, 15)).toContain('big step up');
  });

  it('stays quiet for a normal increase, and never comments on a low week', () => {
    expect(volumeWarning(17, 15)).toBeNull();
    expect(volumeWarning(4, 15)).toBeNull();
  });

  it('stays quiet when there is no baseline to compare against', () => {
    expect(volumeWarning(20, 2)).toBeNull();
  });
});

describe('session volume', () => {
  it('excludes warm-ups', () => {
    expect(
      sessionVolumeKg([
        { weightKg: 40, reps: 10, isWarmup: true },
        { weightKg: 60, reps: 8, isWarmup: false },
        { weightKg: 60, reps: 8, isWarmup: false },
      ]),
    ).toBe(960);
  });
});

describe('adaptive engine', () => {
  const base: AdaptiveInput = {
    exerciseId: 'ex_bench',
    exerciseName: 'Barbell Bench Press',
    history: [
      { topSetKg: 62.5, reps: 8, rpe: 7, hitAllSets: true, at: '2026-07-30' },
      { topSetKg: 62.5, reps: 8, rpe: 7, hitAllSets: true, at: '2026-07-23' },
      { topSetKg: 60, reps: 8, rpe: 8, hitAllSets: true, at: '2026-07-16' },
    ],
    prescribedKg: 62.5,
    repLow: 6,
    repHigh: 8,
    targetRpe: 8,
    loadStepKg: 2.5,
    trainerLocked: false,
    recoveredPct: 88,
    daysSinceLastSession: 4,
    reportedInjury: false,
  };

  it('progresses after two easy sessions at the top of the rep range', () => {
    const r = adaptLoad(base);
    expect(r.newLoadKg).toBe(65);
    expect(r.changed).toBe(true);
    expect(r.changes[0]).toMatchObject({ field: 'Top set load', from: '62.5 kg', to: '65 kg' });
  });

  it('always ships its inputs, a version and its limitations', () => {
    const r = adaptLoad(base);
    expect(r.rulesVersion).toBe('v4.2');
    expect(r.inputs.length).toBeGreaterThan(0);
    expect(r.limitations).toContain('Tell your coach');
  });

  it('backs off after two hard or missed sessions and asks for review', () => {
    const r = adaptLoad({
      ...base,
      history: [
        { topSetKg: 65, reps: 5, rpe: 9.5, hitAllSets: false, at: '2026-07-30' },
        { topSetKg: 65, reps: 6, rpe: 9, hitAllSets: false, at: '2026-07-23' },
        { topSetKg: 62.5, reps: 8, rpe: 8, hitAllSets: true, at: '2026-07-16' },
      ],
      prescribedKg: 65,
    });
    expect(r.newLoadKg).toBe(62.5);
    expect(r.requiresTrainerReview).toBe(true);
  });

  it('never increases load past a trainer lock', () => {
    const r = adaptLoad({ ...base, trainerLocked: true });
    expect(r.newLoadKg).toBe(62.5);
    expect(r.changed).toBe(false);
    expect(r.headline).toContain('locked');
  });

  it('holds load and asks for review when an injury is reported, whatever the history says', () => {
    const r = adaptLoad({ ...base, reportedInjury: true });
    expect(r.changed).toBe(false);
    expect(r.requiresTrainerReview).toBe(true);
  });

  it('eases load when the muscle group has not recovered', () => {
    const r = adaptLoad({ ...base, recoveredPct: 30 });
    expect(r.newLoadKg).toBe(60);
  });

  it('resets after a long layoff instead of picking up where it left off', () => {
    const r = adaptLoad({ ...base, daysSinceLastSession: 30, history: [base.history[0]!] });
    expect(r.newLoadKg).toBeLessThan(62.5);
    expect(r.headline).toContain('reset');
  });

  it('says so plainly on a first attempt rather than inventing a number', () => {
    const r = adaptLoad({ ...base, history: [] });
    expect(r.confidence).toBe('low');
    expect(r.changed).toBe(false);
  });
});
