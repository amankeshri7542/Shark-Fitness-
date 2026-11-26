import { describe, expect, it } from 'vitest';
import { PLAIN_ONLY_SURFACES, PREDATOR_COPY, TRAINING_SURFACES, type CopyKey } from '@shark/design-tokens';
import { copyFor } from '../store';

/**
 * The plain register is not a preference on money, access, safety and privacy
 * surfaces (DESIGN.md "Voice", PLAIN_ONLY_SURFACES). This fails the build if
 * any plain-only surface can render a predator variant.
 */
const keys = Object.keys(PREDATOR_COPY) as CopyKey[];

describe('copy register enforcement', () => {
  it('lists the pass and access surfaces as plain-only', () => {
    expect(PLAIN_ONLY_SURFACES).toEqual(expect.arrayContaining(['pass', 'access', 'access-denied', 'billing', 'payment', 'refund']));
  });

  it.each(PLAIN_ONLY_SURFACES)('%s never renders a predator string, whatever the preference', (surface) => {
    const copy = copyFor('predator', surface);
    for (const key of keys) {
      expect(copy(key)).toBe(PREDATOR_COPY[key].plain);
    }
  });

  it.each(TRAINING_SURFACES)('%s follows the member preference', (surface) => {
    expect(copyFor('predator', surface)('navHome')).toBe('Hunt');
    expect(copyFor('plain', surface)('navHome')).toBe('Today');
  });

  it('keeps plain-only and training surfaces apart', () => {
    const plain = new Set<string>(PLAIN_ONLY_SURFACES);
    for (const surface of TRAINING_SURFACES) expect(plain.has(surface)).toBe(false);
  });
});
