/**
 * Weight units (member preference `unitSystem`).
 *
 * Storage is always kilograms: the API, the outbox and the adaptive engine
 * never see pounds. Conversion happens at the edge, for display and for input
 * typed or stepped in pounds. One pound is exactly 0.45359237 kg (the
 * international avoirdupois pound).
 */
export type UnitSystem = 'metric' | 'imperial';
export type WeightUnit = 'kg' | 'lb';

export const KG_PER_LB = 0.45359237;

export function weightUnit(system: UnitSystem): WeightUnit {
  return system === 'imperial' ? 'lb' : 'kg';
}

export function kgToLb(kg: number): number {
  return kg / KG_PER_LB;
}

export function lbToKg(lb: number): number {
  return lb * KG_PER_LB;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** The number to show for a stored kilogram value, rounded to `decimals`. */
export function toDisplayWeight(kg: number, system: UnitSystem, decimals = 1): number {
  return round(system === 'imperial' ? kgToLb(kg) : kg, decimals);
}

/**
 * Kilograms to store for a value the member entered in their unit. Rounded to
 * grams: enough that a pound value survives the round trip at 0.1 lb.
 */
export function fromDisplayWeight(value: number, system: UnitSystem): number {
  return round(system === 'imperial' ? lbToKg(value) : value, 3);
}

/** `72.5 kg`, `159.8 lb`. Indian digit grouping for large totals. */
export function formatWeight(kg: number, system: UnitSystem, decimals = 1): string {
  const value = toDisplayWeight(kg, system, decimals);
  return `${value.toLocaleString('en-IN', { maximumFractionDigits: decimals })} ${weightUnit(system)}`;
}

/** The +/− step on the set logger: 2.5 kg plates, or 5 lb (2 × 2.5 lb plates). */
export function weightStep(system: UnitSystem): number {
  return system === 'imperial' ? 5 : 2.5;
}

/**
 * One press of the weight stepper, in the member's unit. In pounds the result
 * snaps to the 5 lb grid first so repeated presses never drift through
 * rounding (50 lb + 5 lb is 55 lb, not 55.02 lb).
 */
export function stepWeightKg(currentKg: number, direction: 1 | -1, system: UnitSystem): number {
  const step = weightStep(system);
  const shown = system === 'imperial' ? kgToLb(currentKg) : currentKg;
  // Stored grams make 140 lb come back as 139.998 lb; within half the display
  // precision it is on the grid already.
  const nearest = Math.round(shown / step) * step;
  const onGrid = Math.abs(nearest - shown) < 0.05;
  const next = onGrid
    ? nearest + direction * step
    : direction > 0
      ? Math.ceil(shown / step) * step
      : Math.floor(shown / step) * step;
  return Math.max(0, fromDisplayWeight(round(next, 3), system));
}

const KG_IN_TEXT = /(\d[\d,]*(?:\.\d+)?)\s?kg\b/g;

/**
 * Rewrites every "N kg" inside a sentence the server composed ("100 kg × 5",
 * "+2.5 kg"), so stored display strings follow the member's unit without the
 * API having to know about it. Metric text is returned untouched.
 */
export function convertKgText(text: string, system: UnitSystem): string {
  if (system !== 'imperial') return text;
  return text.replace(KG_IN_TEXT, (_match, digits: string) => {
    const kg = Number(digits.replaceAll(',', ''));
    return Number.isFinite(kg) ? formatWeight(kg, system) : _match;
  });
}
