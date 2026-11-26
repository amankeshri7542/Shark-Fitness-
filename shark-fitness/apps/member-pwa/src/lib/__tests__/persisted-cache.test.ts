import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { Viewer } from '@shark/contracts';
import {
  CACHE_BUSTER,
  CACHE_MAX_AGE_MS,
  deleteSnapshot,
  isPersistable,
  loadSnapshot,
  ownerOf,
  purgeExpiredSnapshots,
  restoreSnapshot,
  saveSnapshot,
  snapshotOwners,
} from '../persisted-cache';

function viewer(userId: string): Viewer {
  return {
    userId,
    tenantId: 'ten_shark',
    memberId: `mem_${userId}`,
    staffId: null,
    name: userId,
    initials: 'XX',
    email: null,
    role: 'member',
    accountState: 'active',
    homeBranchId: 'br_kor',
    permittedBranchIds: ['br_kor'],
    permissions: [],
    preferences: { register: 'plain', unitSystem: 'metric', theme: 'dark', haptics: false, reducedMotion: false },
  };
}

function clientWith(data: Record<string, unknown>): QueryClient {
  const client = new QueryClient();
  for (const [key, value] of Object.entries(data)) client.setQueryData(JSON.parse(key) as unknown[], value);
  return client;
}

const session = (v: Viewer) => ({ viewer: v, branches: [], activeBranchId: 'br_kor' });

afterEach(async () => {
  for (const owner of await snapshotOwners()) await deleteSnapshot(owner);
});

describe('what may be persisted', () => {
  it('allows Home, the training plan, the class list and permissions only', () => {
    expect(isPersistable(['home'])).toBe(true);
    expect(isPersistable(['training', 'plan'])).toBe(true);
    expect(isPersistable(['schedule', '2026-11-25', 'all'])).toBe(true);
    expect(isPersistable(['consents'])).toBe(true);
    for (const key of [['pass'], ['billing'], ['sessions'], ['progress'], ['messages'], ['training', 'history'], ['plan']]) {
      expect(isPersistable(key)).toBe(false);
    }
  });

  it('never writes the entry pass token or billing to disk', async () => {
    const alice = viewer('usr_alice');
    const client = clientWith({
      '["home"]': { greeting: 'Hi' },
      '["pass"]': { token: 'secret-pass-token' },
      '["billing"]': { invoices: [{ id: 'inv_1' }] },
    });
    await saveSnapshot(client, session(alice));
    const snapshot = await loadSnapshot(ownerOf(alice));
    const keys = snapshot!.queries.queries.map((q) => JSON.stringify(q.queryKey));
    expect(keys).toEqual(['["home"]']);
    expect(JSON.stringify(snapshot)).not.toContain('secret-pass-token');
    expect(JSON.stringify(snapshot)).not.toContain('inv_1');
  });
});

describe('per-person snapshots', () => {
  it('only ever returns a snapshot to the person who saved it', async () => {
    const alice = viewer('usr_alice');
    const bob = viewer('usr_bob');
    await saveSnapshot(clientWith({ '["home"]': { who: 'alice' } }), session(alice));

    expect(await loadSnapshot(ownerOf(bob))).toBeNull();
    const restored = new QueryClient();
    restoreSnapshot(restored, (await loadSnapshot(ownerOf(alice)))!);
    expect(restored.getQueryData(['home'])).toEqual({ who: 'alice' });
  });

  it('discards snapshots older than 24 hours or from another cache version', async () => {
    const alice = viewer('usr_alice');
    const savedAt = Date.UTC(2026, 10, 25, 6, 0);
    await saveSnapshot(clientWith({ '["home"]': { n: 1 } }), session(alice), savedAt);

    expect(await loadSnapshot(ownerOf(alice), savedAt + CACHE_MAX_AGE_MS)).not.toBeNull();
    expect(await loadSnapshot(ownerOf(alice), savedAt + CACHE_MAX_AGE_MS + 1)).toBeNull();
    // ...and it is gone, not merely hidden.
    expect(await snapshotOwners()).toEqual([]);
    expect(CACHE_BUSTER).toMatch(/^member-cache-v\d+$/);
  });

  it('purges every expired snapshot at start-up, whoever owns it', async () => {
    const now = Date.UTC(2026, 10, 25, 6, 0);
    await saveSnapshot(clientWith({ '["home"]': {} }), session(viewer('usr_old')), now - CACHE_MAX_AGE_MS - 5);
    await saveSnapshot(clientWith({ '["home"]': {} }), session(viewer('usr_new')), now - 1_000);
    await purgeExpiredSnapshots(now);
    expect(await snapshotOwners()).toEqual(['ten_shark:usr_new']);
  });
});
