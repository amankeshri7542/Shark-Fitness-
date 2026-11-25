/**
 * Entry pass timing (PF-ATT-005).
 *
 * The server issues a short run of single-use tokens, one per 30-second
 * window, and its own clock with them. The phone never trusts its own clock
 * for which window it is: it measures the skew once, when the run arrives, and
 * reads every window through that offset. A phone set five minutes fast still
 * shows the code the desk expects.
 */

export interface IssuedPass {
  token: string;
  window: number;
  validFrom: number;
  expiresAt: number;
}

export interface PassCode {
  rotateSec: number;
  serverEpoch: number;
  passes: IssuedPass[];
}

/** Rotate this many seconds before a code's window ends, so the code on
 *  screen is never the one about to lapse mid-scan. The desk accepts the next
 *  window early (one window of clock skew either side). */
export const ROTATE_EARLY_SEC = 2;

/** Fetch a fresh run once fewer than this many windows remain after the one
 *  on screen, so a slow network never leaves the member without a code. */
export const REFRESH_WHEN_REMAINING = 2;

export function clockOffsetMs(serverEpoch: number, receivedAtMs: number): number {
  return serverEpoch * 1000 - receivedAtMs;
}

export interface CodeOnScreen {
  pass: IssuedPass;
  /** Whole seconds until this code is replaced (never below 1 while shown). */
  secondsLeft: number;
  /** Windows still held after the one on screen. */
  remaining: number;
}

/** The code to show at `nowMs` (device clock), or null when the run is spent. */
export function codeOnScreen(code: PassCode, offsetMs: number, nowMs: number): CodeOnScreen | null {
  const serverSec = (nowMs + offsetMs) / 1000;
  const window = Math.floor(serverSec / code.rotateSec);
  const intoWindow = serverSec - window * code.rotateSec;
  const rotateEarly = code.rotateSec - intoWindow <= ROTATE_EARLY_SEC;
  const target = rotateEarly ? window + 1 : window;
  const index = code.passes.findIndex((pass) => pass.window === target);
  if (index < 0) return null;
  const pass = code.passes[index]!;
  const replaceAt = pass.expiresAt - ROTATE_EARLY_SEC;
  return {
    pass,
    secondsLeft: Math.max(1, Math.ceil(replaceAt - serverSec)),
    remaining: code.passes.length - index - 1,
  };
}

const CARD_KEY = 'shark.passcard';

/** The member number is not a credential: reception reads it aloud. It is kept
 *  so the offline fallback works even when the app is opened with no signal. */
export function rememberMemberNo(userId: string, memberNo: string, name: string): void {
  try {
    localStorage.setItem(`${CARD_KEY}.${userId}`, JSON.stringify({ memberNo, name }));
  } catch {
    /* private mode or full storage: the online pass still works */
  }
}

export function rememberedMemberNo(userId: string | undefined): { memberNo: string; name: string } | null {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(`${CARD_KEY}.${userId}`);
    return raw ? (JSON.parse(raw) as { memberNo: string; name: string }) : null;
  } catch {
    return null;
  }
}

export function forgetPassCards(): void {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(CARD_KEY)) localStorage.removeItem(key);
  } catch {
    /* nothing to clear */
  }
}
