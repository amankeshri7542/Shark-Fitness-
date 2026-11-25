import { describe, expect, it } from 'vitest';
import {
  KG_PER_LB,
  convertKgText,
  formatWeight,
  fromDisplayWeight,
  kgToLb,
  lbToKg,
  stepWeightKg,
  toDisplayWeight,
  weightStep,
  weightUnit,
} from '../units.js';

describe('weight units', () => {
  it('uses the exact international pound', () => {
    expect(KG_PER_LB).toBe(0.45359237);
    expect(lbToKg(1)).toBe(0.45359237);
    expect(kgToLb(0.45359237)).toBeCloseTo(1, 12);
    expect(kgToLb(100)).toBeCloseTo(220.462, 3);
  });

  it('displays a stored kilogram value in the chosen unit', () => {
    expect(toDisplayWeight(100, 'metric')).toBe(100);
    expect(toDisplayWeight(100, 'imperial')).toBe(220.5);
    expect(toDisplayWeight(60, 'imperial', 0)).toBe(132);
    expect(formatWeight(72.5, 'metric')).toBe('72.5 kg');
    expect(formatWeight(72.5, 'imperial')).toBe('159.8 lb');
    expect(formatWeight(12_500, 'metric', 0)).toBe('12,500 kg');
    expect(weightUnit('imperial')).toBe('lb');
  });

  it('stores kilograms for a value entered in pounds, surviving the round trip', () => {
    for (const lb of [5, 45, 135, 225, 315.5, 0.1]) {
      const kg = fromDisplayWeight(lb, 'imperial');
      expect(toDisplayWeight(kg, 'imperial')).toBe(lb);
    }
    expect(fromDisplayWeight(80, 'metric')).toBe(80);
  });

  it('steps 2.5 kg or 5 lb, snapping to the grid so presses never drift', () => {
    expect(weightStep('metric')).toBe(2.5);
    expect(weightStep('imperial')).toBe(5);
    expect(stepWeightKg(60, 1, 'metric')).toBe(62.5);
    expect(stepWeightKg(60, -1, 'metric')).toBe(57.5);
    // 60 kg is 132.28 lb: the first press snaps to 135, the next to 140.
    const once = stepWeightKg(60, 1, 'imperial');
    expect(toDisplayWeight(once, 'imperial')).toBe(135);
    let kg = once;
    for (let i = 0; i < 20; i += 1) kg = stepWeightKg(kg, 1, 'imperial');
    expect(toDisplayWeight(kg, 'imperial')).toBe(235);
    expect(toDisplayWeight(stepWeightKg(60, -1, 'imperial'), 'imperial')).toBe(130);
    expect(stepWeightKg(1, -1, 'imperial')).toBe(0);
  });

  it('converts the kilogram figures inside server-composed text', () => {
    expect(convertKgText('100 kg × 5', 'imperial')).toBe('220.5 lb × 5');
    expect(convertKgText('+2.5 kg', 'imperial')).toBe('+5.5 lb');
    expect(convertKgText('Last time 1,000 kg total', 'imperial')).toBe('Last time 2,204.6 lb total');
    expect(convertKgText('8 reps', 'imperial')).toBe('8 reps');
    expect(convertKgText('100 kg × 5', 'metric')).toBe('100 kg × 5');
  });
});
