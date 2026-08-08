/** Deterministic PRNG so `pnpm db:reset` always produces the same demo data —
 *  screenshots, tests and bug reports all refer to the same gym. */
export function makeRandom(seed = 20260806) {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
  return {
    next,
    int: (min: number, max: number): number => Math.floor(next() * (max - min + 1)) + min,
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
    chance: (p: number): boolean => next() < p,
    shuffle: <T>(items: T[]): T[] => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
  };
}

export type Random = ReturnType<typeof makeRandom>;
