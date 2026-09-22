import { afterEach, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => new Map<string, Record<string, unknown>>());
const send = vi.hoisted(() => vi.fn());
vi.mock('idb', () => ({ openDB: async () => ({
  getAllFromIndex: async (_store: string, _index: string, owner: string) => [...storage.values()].filter((e) => e.ownerKey === owner),
  put: async (_store: string, entry: Record<string, unknown>) => { storage.set(entry.key as string, entry); },
  delete: async (_store: string, key: string) => { storage.delete(key); },
}) }));
vi.mock('../api', async (original) => ({ ...await original<typeof import('../api')>(), api: send }));
import { startOutbox, stopOutbox } from '../outbox';

afterEach(() => { stopOutbox(); storage.clear(); send.mockReset(); });

it('replays interrupted writes for the signed-in owner with their original idempotency key', async () => {
  for (const owner of ['gym:alice', 'gym:bob']) {
    storage.set(`${owner}:attempt`, { key: `${owner}:attempt`, ownerKey: owner, clientId: 'attempt', kind: 'workout',
      method: 'POST', path: '/member/workouts', body: {}, createdAt: 1, attempts: 0, status: 'sending', nextAttemptAt: 0 });
  }
  send.mockResolvedValue({ ok: true });
  startOutbox('gym:alice');
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith('/member/workouts', { method: 'POST', body: {}, idempotencyKey: 'attempt' }));
  await vi.waitFor(() => expect(storage.has('gym:alice:attempt')).toBe(false));
  expect(storage.get('gym:bob:attempt')?.status).toBe('sending');
});
