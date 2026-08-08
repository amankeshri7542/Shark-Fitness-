import { openDB, type IDBPDatabase } from 'idb';
import { useEffect, useState } from 'react';
import { ApiError, OfflineError, api } from './api';

export type OutboxStatus = 'queued' | 'sending' | 'synced' | 'failed' | 'conflict';

export interface OutboxEntry {
  key: string;
  ownerKey: string;
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

const DB_NAME = 'shark-outbox-v2';
const STORE = 'entries';
let dbPromise: Promise<IDBPDatabase> | null = null;
let activeOwner: string | null = null;
let flushTimer: number | null = null;
let onlineHandler: (() => void) | null = null;
let visibilityHandler: (() => void) | null = null;

function database(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(DB_NAME, 1, {
    upgrade(db) {
      const store = db.createObjectStore(STORE, { keyPath: 'key' });
      store.createIndex('ownerKey', 'ownerKey');
      store.createIndex('status', 'status');
    },
  });
  return dbPromise;
}

const listeners = new Set<() => void>();
const notify = (): void => listeners.forEach((listener) => listener());

export function subscribeToOutbox(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function enqueue(
  entry: Omit<OutboxEntry, 'key' | 'ownerKey' | 'attempts' | 'status' | 'createdAt' | 'nextAttemptAt'>,
): Promise<void> {
  if (!activeOwner) throw new Error('Cannot queue an offline write without a signed-in owner');
  const db = await database();
  await db.put(STORE, {
    ...entry,
    key: `${activeOwner}:${entry.clientId}`,
    ownerKey: activeOwner,
    createdAt: Date.now(),
    attempts: 0,
    status: 'queued' satisfies OutboxStatus,
    nextAttemptAt: 0,
  });
  notify();
  void flush();
}

export async function pending(): Promise<OutboxEntry[]> {
  if (!activeOwner) return [];
  const db = await database();
  const all = (await db.getAllFromIndex(STORE, 'ownerKey', activeOwner)) as OutboxEntry[];
  return all.filter((entry) => entry.status !== 'synced');
}

export async function pendingCount(): Promise<number> {
  return (await pending()).length;
}

let flushing = false;

function backoffMs(attempts: number): number {
  return Math.min(60_000, 1_000 * 2 ** attempts);
}

export async function flush(): Promise<void> {
  const ownerAtStart = activeOwner;
  if (flushing || !ownerAtStart || !navigator.onLine) return;
  flushing = true;

  try {
    const db = await database();
    const queue = (await db.getAllFromIndex(STORE, 'ownerKey', ownerAtStart)) as OutboxEntry[];
    const due = queue
      .filter((entry) => (entry.status === 'queued' || entry.status === 'failed') && entry.nextAttemptAt <= Date.now())
      .sort((a, b) => a.createdAt - b.createdAt);

    for (const entry of due) {
      if (activeOwner !== ownerAtStart || entry.ownerKey !== ownerAtStart) break;

      await db.put(STORE, { ...entry, status: 'sending' satisfies OutboxStatus });
      notify();

      try {
        await api(entry.path, { method: entry.method, body: entry.body, idempotencyKey: entry.clientId });
        await db.delete(STORE, entry.key);
      } catch (error) {
        if (error instanceof OfflineError) {
          await db.put(STORE, { ...entry, status: 'queued' satisfies OutboxStatus });
          notify();
          break;
        }

        if (error instanceof ApiError) {
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
  if (!activeOwner) return;
  const db = await database();
  await db.delete(STORE, `${activeOwner}:${clientId}`);
  notify();
}

export async function retryAll(): Promise<void> {
  if (!activeOwner) return;
  const db = await database();
  const all = (await db.getAllFromIndex(STORE, 'ownerKey', activeOwner)) as OutboxEntry[];
  for (const entry of all) {
    if (entry.status === 'failed' || entry.status === 'conflict') {
      await db.put(STORE, { ...entry, status: 'queued' satisfies OutboxStatus, nextAttemptAt: 0 });
    }
  }
  notify();
  await flush();
}

export function startOutbox(ownerKey: string): () => void {
  stopOutbox();
  activeOwner = ownerKey;
  onlineHandler = () => void flush();
  visibilityHandler = () => {
    if (document.visibilityState === 'visible') void flush();
  };
  window.addEventListener('online', onlineHandler);
  document.addEventListener('visibilitychange', visibilityHandler);
  flushTimer = window.setInterval(() => void flush(), 15_000);
  void flush();
  notify();
  return stopOutbox;
}

export function stopOutbox(): void {
  if (onlineHandler) window.removeEventListener('online', onlineHandler);
  if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler);
  if (flushTimer !== null) window.clearInterval(flushTimer);
  onlineHandler = null;
  visibilityHandler = null;
  flushTimer = null;
  activeOwner = null;
  notify();
}

export function useOutboxCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const read = (): void => void pendingCount().then(setCount);
    read();
    return subscribeToOutbox(read);
  }, []);
  return count;
}

export function useOutbox(): { entries: OutboxEntry[]; refresh: () => void } {
  const [entries, setEntries] = useState<OutboxEntry[]>([]);
  const refresh = (): void => void pending().then(setEntries);
  useEffect(() => {
    refresh();
    return subscribeToOutbox(refresh);
  }, []);
  return { entries, refresh };
}
