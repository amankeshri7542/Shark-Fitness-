import { openDB, type IDBPDatabase } from 'idb';
import { create } from 'zustand';
import { dehydrate, hydrate, type DehydratedState, type Query, type QueryClient } from '@tanstack/react-query';
import type { Branch, Viewer } from '@shark/contracts';

/**
 * The member's last-seen data, kept in IndexedDB so the app opens with
 * something useful when there is no network (PRD 01 §1.4 principle 4,
 * PRD 03 UX-M02 "offline cached").
 *
 * Shared phones are the risk this design answers:
 * - One snapshot per signed-in person, keyed `tenantId:userId`. A snapshot is
 *   only ever read back for that same person.
 * - 24 hours at most, and a version buster: anything older or from another
 *   cache format is deleted, not shown.
 * - An allow-list of what may be written at all. The entry pass token and
 *   billing are never persisted; neither is anything not listed here.
 * - Sign-out deletes the snapshot (lib/session-wipe.ts).
 */

export const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Bump when a persisted payload's shape changes in a way old screens would
 *  misread. Old snapshots are then discarded instead of rendered. */
export const CACHE_BUSTER = 'member-cache-v1';

const DB_NAME = 'shark-query-cache';
const STORE = 'snapshots';
const LAST_OWNER_KEY = 'shark.member.last-owner';
const WRITE_DELAY_MS = 800;

/** Query-key roots allowed on disk: Home, the training plan, Book's class
 *  list and Profile's permissions. */
const PERSISTED: ReadonlyArray<readonly string[]> = [['home'], ['training', 'plan'], ['schedule'], ['consents']];
/** Named so a reviewer can see the refusal is deliberate. */
export const NEVER_PERSISTED = ['pass', 'billing', 'sessions', 'realtime-ticket'] as const;

export interface Snapshot {
  owner: string;
  buster: string;
  savedAt: number;
  viewer: Viewer;
  branches: Branch[];
  activeBranchId: string | null;
  queries: DehydratedState;
}

export interface SessionShape {
  viewer: Viewer | null;
  branches: Branch[];
  activeBranchId: string | null;
}

export function ownerOf(viewer: Pick<Viewer, 'tenantId' | 'userId'>): string {
  return `${viewer.tenantId}:${viewer.userId}`;
}

export function isPersistable(queryKey: readonly unknown[]): boolean {
  const root = queryKey[0];
  if (typeof root !== 'string' || (NEVER_PERSISTED as readonly string[]).includes(root)) return false;
  return PERSISTED.some((prefix) => prefix.every((part, index) => queryKey[index] === part));
}

/** When the snapshot on screen was written: drives the offline banner. */
export const useCacheMeta = create<{ savedAt: number | null }>(() => ({ savedAt: null }));

let dbPromise: Promise<IDBPDatabase> | null = null;
function database(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(DB_NAME, 1, {
    upgrade(db) {
      db.createObjectStore(STORE, { keyPath: 'owner' });
    },
  });
  return dbPromise;
}

export function rememberLastOwner(owner: string | null): void {
  try {
    if (owner) localStorage.setItem(LAST_OWNER_KEY, owner);
    else localStorage.removeItem(LAST_OWNER_KEY);
  } catch {
    /* Without storage there is simply no offline start. */
  }
}

export function lastOwner(): string | null {
  try {
    return localStorage.getItem(LAST_OWNER_KEY);
  } catch {
    return null;
  }
}

function fresh(snapshot: Snapshot, now: number): boolean {
  return snapshot.buster === CACHE_BUSTER && now - snapshot.savedAt <= CACHE_MAX_AGE_MS && now >= snapshot.savedAt - 60_000;
}

/** The snapshot for this person, or null. Stale or foreign-format snapshots
 *  are deleted on the way. */
export async function loadSnapshot(owner: string, now = Date.now()): Promise<Snapshot | null> {
  try {
    const db = await database();
    const snapshot = (await db.get(STORE, owner)) as Snapshot | undefined;
    if (snapshot && fresh(snapshot, now)) return snapshot;
    if (snapshot) await db.delete(STORE, owner);
  } catch {
    /* IndexedDB unavailable (private mode): behave as if nothing was saved. */
  }
  return null;
}

export async function saveSnapshot(client: QueryClient, session: SessionShape, now = Date.now()): Promise<void> {
  if (!session.viewer) return;
  const owner = ownerOf(session.viewer);
  const queries = dehydrate(client, {
    shouldDehydrateQuery: (query: Query) => query.state.status === 'success' && isPersistable(query.queryKey),
  });
  const snapshot: Snapshot = {
    owner,
    buster: CACHE_BUSTER,
    savedAt: now,
    viewer: session.viewer,
    branches: session.branches,
    activeBranchId: session.activeBranchId,
    queries,
  };
  const db = await database();
  await db.put(STORE, snapshot);
  useCacheMeta.setState({ savedAt: now });
}

/** Seeds the cache from a snapshot. Never overwrites fresher in-memory data. */
export function restoreSnapshot(client: QueryClient, snapshot: Snapshot): void {
  hydrate(client, snapshot.queries);
  useCacheMeta.setState({ savedAt: snapshot.savedAt });
}

export async function deleteSnapshot(owner: string): Promise<void> {
  try {
    const db = await database();
    await db.delete(STORE, owner);
  } catch {
    /* nothing to delete */
  }
  useCacheMeta.setState({ savedAt: null });
}

/** Deletes every snapshot past its age or from an older format, whoever it
 *  belongs to. Run at start-up. */
export async function purgeExpiredSnapshots(now = Date.now()): Promise<void> {
  try {
    const db = await database();
    const all = (await db.getAll(STORE)) as Snapshot[];
    await Promise.all(all.filter((s) => !fresh(s, now)).map((s) => db.delete(STORE, s.owner)));
  } catch {
    /* best effort */
  }
}

/** Every owner with a snapshot on this device (tests and sign-out checks). */
export async function snapshotOwners(): Promise<string[]> {
  const db = await database();
  return (await db.getAllKeys(STORE)).map(String);
}

/**
 * Writes the snapshot shortly after any persistable query settles. Returns a
 * stop function. `session` is read at write time, so a sign-out between the
 * change and the write never saves under the wrong person.
 */
export function startPersisting(client: QueryClient, session: () => SessionShape): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const owner = session().viewer ? ownerOf(session().viewer!) : null;
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success' || !isPersistable(event.query.queryKey)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const current = session();
      if (!current.viewer || ownerOf(current.viewer) !== owner) return;
      void saveSnapshot(client, current).catch(() => undefined);
    }, WRITE_DELAY_MS);
  });
  return () => {
    if (timer) clearTimeout(timer);
    unsubscribe();
  };
}
