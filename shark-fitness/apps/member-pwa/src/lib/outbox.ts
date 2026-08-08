import { openDB, type IDBPDatabase } from 'idb';
import { useEffect, useState } from 'react';
import { ApiError, OfflineError, api } from './api';

/**
 * Offline mutation outbox — Engineering PRD §"Mobile offline outbox".
 *
 * The rule that shapes this file: network loss never destroys workout input.
 * Every write that can happen on a gym floor goes through here first, is
 * persisted before the request is attempted, and carries a client-generated id
 * that doubles as the idempotency key. Replaying an entry is a no-op server
 * side, so a flaky connection costs a retry and nothing else.
 */

export type OutboxStatus = 'queued' | 'sending' | 'synced' | 'failed' | 'conflict';

export interface OutboxEntry {
  clientId: string;
  kind: string;
  method: 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body: unknown;
  createdAt: number;
  attempts: number;
  status: OutboxStatus;
  lastError?: string;
  nextAttemptAt: number;
}

const DB_NAME = 'shark-outbox';
const STORE = 'entries';

let dbPromise: Promise<IDBPDatabase> | null = null;

function database(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(DB_NAME, 1, {
    upgrade(db) {
      const store = db.createObjectStore(STORE, { keyPath: 'clientId' });
      store.createIndex('status', 'status');
    },
  });
  return dbPromise;
}

const listeners = new Set<() => void>();
const notify = (): void => listeners.forEach((l) => l());

export function subscribeToOutbox(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function enqueue(entry: Omit<OutboxEntry, 'attempts' | 'status' | 'createdAt' | 'nextAttemptAt'>): Promise<void> {
  const db = await database();
  await db.put(STORE, {
    ...entry,
    createdAt: Date.now(),
    attempts: 0,
    status: 'queued' satisfies OutboxStatus,
    nextAttemptAt: 0,
  });
  notify();
  void flush();
}

export async function pending(): Promise<OutboxEntry[]> {
  const db = await database();
  const all = (await db.getAll(STORE)) as OutboxEntry[];
  return all.filter((e) => e.status === 'queued' || e.status === 'sending' || e.status === 'failed');
}

export async function pendingCount(): Promise<number> {
  return (await pending()).length;
}

let flushing = false;

/** Exponential backoff, capped. A gym basement is not a reason to hammer. */
function backoffMs(attempts: number): number {
  return Math.min(60_000, 1_000 * 2 ** attempts);
}

export async function flush(): Promise<void> {
  if (flushing || !navigator.onLine) return;
  flushing = true;

  try {
    const db = await database();
    const queue = (await db.getAll(STORE)) as OutboxEntry[];
    const due = queue
      .filter((e) => (e.status === 'queued' || e.status === 'failed') && e.nextAttemptAt <= Date.now())
      .sort((a, b) => a.createdAt - b.createdAt);

    for (const entry of due) {
      await db.put(STORE, { ...entry, status: 'sending' satisfies OutboxStatus });
      notify();

      try {
        await api(entry.path, {
          method: entry.method,
          body: entry.body,
          idempotencyKey: entry.clientId,
        });
        await db.delete(STORE, entry.clientId);
      } catch (error) {
        if (error instanceof OfflineError) {
          // Still offline. Put it back untouched and stop — no point burning
          // through the rest of the queue against a dead connection.
          await db.put(STORE, { ...entry, status: 'queued' satisfies OutboxStatus });
          notify();
          break;
        }

        if (error instanceof ApiError) {
          // A 4xx that is not a conflict will never succeed on retry. Park it
          // as failed so the member is told, rather than looping forever.
          const permanent = error.status >= 400 && error.status < 500 && error.code !== 'CONFLICT';
          await db.put(STORE, {
            ...entry,
            attempts: entry.attempts + 1,
            status: (permanent ? 'conflict' : 'failed') satisfies OutboxStatus,
            lastError: error.message,
            nextAttemptAt: Date.now() + backoffMs(entry.attempts + 1),
          });
        } else {
          await db.put(STORE, {
            ...entry,
            attempts: entry.attempts + 1,
            status: 'failed' satisfies OutboxStatus,
            lastError: 'Something went wrong sending this.',
            nextAttemptAt: Date.now() + backoffMs(entry.attempts + 1),
          });
        }
        notify();
      }
    }
  } finally {
    flushing = false;
    notify();
  }
}

export async function discard(clientId: string): Promise<void> {
  const db = await database();
  await db.delete(STORE, clientId);
  notify();
}

export async function retryAll(): Promise<void> {
  const db = await database();
  const all = (await db.getAll(STORE)) as OutboxEntry[];
  for (const entry of all) {
    if (entry.status === 'failed' || entry.status === 'conflict') {
      await db.put(STORE, { ...entry, status: 'queued' satisfies OutboxStatus, nextAttemptAt: 0 });
    }
  }
  notify();
  await flush();
}

export function startOutbox(): void {
  window.addEventListener('online', () => void flush());
  // A tab coming back to the foreground is the most common moment a member
  // regains signal after a session in the basement.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void flush();
  });
  setInterval(() => void flush(), 15_000);
  void flush();
}

export function useOutboxCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const read = (): void => {
      void pendingCount().then(setCount);
    };
    read();
    return subscribeToOutbox(read);
  }, []);
  return count;
}

export function useOutbox(): { entries: OutboxEntry[]; refresh: () => void } {
  const [entries, setEntries] = useState<OutboxEntry[]>([]);
  const refresh = (): void => {
    void pending().then(setEntries);
  };
  useEffect(() => {
    refresh();
    return subscribeToOutbox(refresh);
  }, []);
  return { entries, refresh };
}
