import { useEffect, useMemo, useRef } from 'react';
import { idempotencyKey } from './api';

/* — One logical write, one `Idempotency-Key`, across ambiguous retries.

   The server wraps its retryable writes in `runIdempotently()`, which stores
   the response against the key and replays it rather than doing the work
   twice. That protection is only ever as good as the key the client sends,
   and `idempotencyKey()` ends every key it mints with a random suffix — so a
   key built inside `mutationFn` is a *new* key on every press. When the server
   commits and the response is lost on the way back, the operator sees an error
   and presses again, and a fresh key asks the server a brand-new question: a
   second ticket, a second feedback record, a second intervention.

   The Store till and the ticket reply had each already grown their own copy of
   the rule, by hand and in different shapes (one `useRef`, one `useState`).
   This is that rule, once, so the next screen inherits it instead of
   rediscovering it after the duplicate has already been written. — */

export interface IdempotentAttempt {
  /**
   * The key for this body. Stable while the body is unchanged, so a retry of
   * an ambiguous failure is answered from the first attempt's record.
   */
  keyFor: (body: unknown) => string;
  /**
   * Spend the attempt. Call once the write is known to have landed — or when
   * the operator abandons it. The next call to `keyFor` then mints a fresh
   * key, which is what stops a genuinely new but identical record (the same
   * feedback score twice, the same reply to two members) from being swallowed
   * as a replay of the one before it.
   */
  retire: () => void;
}

/**
 * Holds one idempotency key against the body it was minted for.
 *
 * The fingerprint is the request body verbatim, never a summary of it: the
 * server hashes the body alongside the key and refuses a key replayed against
 * different content, so anything the body carries has to be able to move the
 * fingerprint. Taking the body at `keyFor` time is what makes that true by
 * construction rather than by the caller remembering to keep a hand-written
 * fingerprint in step with the payload.
 *
 * Only the most recent fingerprint is held. Editing a draft and changing it
 * back therefore mints a new key rather than recovering the first one — the
 * conservative direction, because the alternative is a map of every body ever
 * sent, which risks answering a real new record with a stale response.
 */
export function useIdempotentAttempt(scope: string, ...parts: (string | number)[]): IdempotentAttempt {
  const held = useRef<{ fingerprint: string; key: string } | null>(null);
  const label = useRef({ scope, parts });

  // Keep the label current for a scope built from props — a branch that was
  // switched, a ticket that was opened. Effects run after render and long
  // before any handler can call `keyFor`, so a key is never minted against a
  // stale label. Only the human-readable prefix depends on this; correctness
  // rests on the fingerprint below.
  useEffect(() => {
    label.current = { scope, parts };
  });

  // Built once and never rebuilt, so a caller can hold it in a dependency list
  // without the attempt resetting underneath them. Neither ref is touched
  // while rendering: both are read only from the handler that sends the write.
  return useMemo<IdempotentAttempt>(
    () => ({
      keyFor: (body: unknown): string => {
        const fingerprint = JSON.stringify(body ?? null);
        if (held.current?.fingerprint !== fingerprint) {
          held.current = { fingerprint, key: idempotencyKey(label.current.scope, ...label.current.parts) };
        }
        return held.current.key;
      },
      retire: (): void => {
        held.current = null;
      },
    }),
    [],
  );
}
