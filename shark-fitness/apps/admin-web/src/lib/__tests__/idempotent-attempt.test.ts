import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useIdempotentAttempt } from '../idempotent-attempt';

/* ============================================================================
   The rule itself, away from any screen that depends on it.

   Store and Support had each grown their own copy of this by hand, in
   different shapes, after the same bug was found twice. These are the four
   properties the shared version has to hold so the next screen inherits them
   instead of rediscovering them after a duplicate has already been written.
   ========================================================================= */

describe('useIdempotentAttempt', () => {
  it('holds one key while the body is unchanged, so an ambiguous retry replays', () => {
    const { result } = renderHook(() => useIdempotentAttempt('scope'));
    const body = { amount: 1, note: 'x' };

    // A structurally equal but distinct object is the same logical request —
    // React re-renders rebuild the payload every time, and a key that turned
    // over on identity alone would protect nothing.
    expect(result.current.keyFor(body)).toBe(result.current.keyFor({ amount: 1, note: 'x' }));
  });

  it('mints a new key once the body materially changes', () => {
    const { result } = renderHook(() => useIdempotentAttempt('scope'));

    const first = result.current.keyFor({ amount: 1 });
    // The server hashes the body alongside the key and refuses a key replayed
    // against different content, so a changed request must not carry the old
    // key — that would be a 409 rather than a corrected write.
    expect(result.current.keyFor({ amount: 2 })).not.toBe(first);
  });

  it('gives a genuinely new record a new key once the attempt is retired', () => {
    const { result } = renderHook(() => useIdempotentAttempt('scope'));
    const body = { amount: 1 };

    const first = result.current.keyFor(body);
    act(() => result.current.retire());
    // Two members can give the same feedback score, and two customers can buy
    // the same basket. Without this the second is silently answered with the
    // first one's stored response and never written at all.
    expect(result.current.keyFor(body)).not.toBe(first);
  });

  it('keeps a stable identity across renders so callers can hold it', () => {
    const { result, rerender } = renderHook(({ scope }) => useIdempotentAttempt(scope), {
      initialProps: { scope: 'a' },
    });

    const before = result.current;
    const key = result.current.keyFor({ amount: 1 });
    rerender({ scope: 'b' });

    expect(result.current).toBe(before);
    // A re-render — including one that changed the scope label — is not a new
    // attempt. The key in flight has to survive it.
    expect(result.current.keyFor({ amount: 1 })).toBe(key);
  });
});
