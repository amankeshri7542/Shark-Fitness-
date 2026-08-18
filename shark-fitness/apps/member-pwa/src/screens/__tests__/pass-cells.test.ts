import { describe, expect, it } from 'vitest';
import { passCells } from '../Pass';

/**
 * The grid generator was lifted out of the component during lint hardening
 * (it reassigns a local while mapping, which a render pass may not do). This
 * reproduces the original in-component algorithm so the extraction is proved
 * to be behaviour-preserving rather than merely plausible.
 */
function originalCells(token: string, size: number): boolean[] {
  let state = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    state ^= token.charCodeAt(index);
    state = Math.imul(state, 16777619) >>> 0;
  }

  const finder = (row: number, col: number, row0: number, col0: number): boolean => {
    const y = row - row0;
    const x = col - col0;
    if (x < 0 || y < 0 || x > 6 || y > 6) return false;
    return x === 0 || y === 0 || x === 6 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4);
  };

  return Array.from({ length: size * size }, (_, index) => {
    const row = Math.floor(index / size);
    const col = index % size;
    if (finder(row, col, 1, 1) || finder(row, col, 1, size - 8) || finder(row, col, size - 8, 1)) return true;
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % 2 === 0;
  });
}

describe('pass grid', () => {
  it('matches the pre-extraction algorithm exactly', () => {
    for (const token of ['pass_abc123', 'v2.9f8e7d.signature', '', 'x']) {
      expect(passCells(token, 25)).toEqual(originalCells(token, 25));
    }
  });

  it('draws the same block every time for one token', () => {
    expect(passCells('pass_abc123', 25)).toEqual(passCells('pass_abc123', 25));
  });

  it('draws a different block once the token rotates', () => {
    expect(passCells('pass_abc123', 25)).not.toEqual(passCells('pass_abc124', 25));
  });

  it('fills the three finder corners so the block reads as a code', () => {
    const size = 25;
    const cells = passCells('pass_abc123', size);
    const at = (row: number, col: number) => cells[row * size + col];

    // Top-left, top-right and bottom-left finder rings are always solid.
    expect(at(1, 1)).toBe(true);
    expect(at(1, size - 8)).toBe(true);
    expect(at(size - 8, 1)).toBe(true);
  });

  it('produces one cell per grid square', () => {
    expect(passCells('pass_abc123', 25)).toHaveLength(625);
  });
});
