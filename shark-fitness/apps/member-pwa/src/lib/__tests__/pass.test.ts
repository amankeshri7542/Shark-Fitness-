import { describe, expect, it } from 'vitest';
import { clockOffsetMs, codeOnScreen, type PassCode } from '../pass';

const WINDOW = 59_000_000;
const code: PassCode = {
  rotateSec: 30,
  serverEpoch: WINDOW * 30,
  passes: Array.from({ length: 6 }, (_, i) => ({
    token: `t${i}`,
    window: WINDOW + i,
    validFrom: (WINDOW + i) * 30,
    expiresAt: (WINDOW + i + 1) * 30,
  })),
};

describe('codeOnScreen', () => {
  it('reads the window through the server clock, not the phone clock', () => {
    // The phone runs five minutes fast.
    const phoneNow = WINDOW * 30_000 + 300_000 + 5_000;
    const offset = clockOffsetMs(WINDOW * 30 + 5, phoneNow);
    const shown = codeOnScreen(code, offset, phoneNow)!;
    expect(shown.pass.token).toBe('t0');
    expect(shown.secondsLeft).toBe(23);
    expect(shown.remaining).toBe(5);
  });

  it('switches to the next code two seconds early and never shows zero', () => {
    const at = (sec: number) => codeOnScreen(code, 0, (WINDOW * 30 + sec) * 1000)!;
    expect(at(27.9).pass.token).toBe('t0');
    expect(at(27.9).secondsLeft).toBe(1);
    expect(at(28).pass.token).toBe('t1');
    expect(at(28).secondsLeft).toBe(30);
  });

  it('returns null once the run is spent', () => {
    expect(codeOnScreen(code, 0, (WINDOW + 6) * 30_000)).toBeNull();
    expect(codeOnScreen(code, 0, (WINDOW - 1) * 30_000)).toBeNull();
  });
});
