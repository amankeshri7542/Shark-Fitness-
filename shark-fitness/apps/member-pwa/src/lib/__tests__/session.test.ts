import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Viewer } from '@shark/contracts';

const send = vi.hoisted(() => vi.fn());
vi.mock('../api', async (original) => ({ ...(await original<typeof import('../api')>()), api: send }));

import { describeUnsynced, enqueue, pendingFor, startOutbox, stopOutbox } from '../outbox';
import { lastOwner, ownerOf, rememberLastOwner, saveSnapshot, snapshotOwners } from '../persisted-cache';
import { queryClient } from '../query-client';
import { signOutAndWipe, unsyncedWarning } from '../session';
import { takeReturnRoute, useSession, useWorkout } from '../store';
import { ApiError } from '../api';

const aman: Viewer = {
  userId: 'usr_aman',
  tenantId: 'ten_shark',
  memberId: 'mem_aman',
  staffId: null,
  name: 'Aman',
  initials: 'AV',
  email: null,
  role: 'member',
  accountState: 'active',
  homeBranchId: 'br_kor',
  permittedBranchIds: ['br_kor'],
  permissions: [],
  preferences: { register: 'plain', unitSystem: 'metric', theme: 'dark', haptics: false, reducedMotion: false },
};
const OWNER = ownerOf(aman);

beforeEach(() => {
  send.mockReset();
  useSession.setState({ viewer: aman, status: 'signed-in', branches: [], activeBranchId: 'br_kor', sessionEnded: false });
  Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
});

afterEach(async () => {
  stopOutbox();
  localStorage.clear();
  sessionStorage.clear();
  queryClient.clear();
  for (const owner of await snapshotOwners()) {
    const { deleteSnapshot } = await import('../persisted-cache');
    await deleteSnapshot(owner);
  }
});

describe('unsynced warning', () => {
  it('names what would be lost, in words', () => {
    expect(describeUnsynced([])).toBeNull();
    expect(describeUnsynced([{ kind: 'workout-set' }])).toBe("1 workout set hasn't synced yet");
    expect(describeUnsynced([{ kind: 'workout-set' }, { kind: 'workout-set' }, { kind: 'workout-set' }])).toBe(
      "3 workout sets haven't synced yet",
    );
    expect(describeUnsynced([{ kind: 'workout-set' }, { kind: 'message-send' }, { kind: 'habit-log' }])).toBe(
      "1 workout set, 1 message and 1 habit check-in haven't synced yet",
    );
  });

  it('reads the signed-in person’s queue', async () => {
    startOutbox(OWNER);
    await enqueue({ clientId: 'set-1', kind: 'workout-set', method: 'POST', path: '/member/training/workouts', body: {} });
    await enqueue({ clientId: 'set-2', kind: 'workout-set', method: 'POST', path: '/member/training/workouts', body: {} });
    expect(await unsyncedWarning()).toBe("2 workout sets haven't synced yet");
  });
});

describe('sign-out', () => {
  it('leaves nothing of the member on the device', async () => {
    send.mockResolvedValue(undefined);
    startOutbox(OWNER);
    await enqueue({ clientId: 'set-1', kind: 'workout-set', method: 'POST', path: '/member/training/workouts', body: {} });
    queryClient.setQueryData(['home'], { hello: 'aman' });
    await saveSnapshot(queryClient, useSession.getState());
    rememberLastOwner(OWNER);
    localStorage.setItem('shark.workout', '{"clientId":"w1"}');
    localStorage.setItem('shark.workout.plan', '{}');
    localStorage.setItem('shark.workout.done.w0', '{}');
    localStorage.setItem('shark.member.theme', 'light');
    localStorage.setItem('shark.member.push-device', JSON.stringify({ owner: OWNER, id: 'psub_1', endpoint: 'https://push.example/1' }));

    const clearAppBadge = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clearAppBadge', { value: clearAppBadge, configurable: true });

    await signOutAndWipe();

    // The installed app's icon no longer shows this member's unread count.
    expect(clearAppBadge).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith('/me/push-subscriptions/psub_1', { method: 'DELETE' });
    expect(send).toHaveBeenCalledWith('/auth/sign-out', { method: 'POST' });
    expect(useSession.getState().status).toBe('signed-out');
    expect(queryClient.getQueryData(['home'])).toBeUndefined();
    expect(await snapshotOwners()).toEqual([]);
    expect(await pendingFor(OWNER)).toEqual([]);
    expect(lastOwner()).toBeNull();
    expect(Object.keys(localStorage).filter((k) => k.startsWith('shark.workout'))).toEqual([]);
    expect(localStorage.getItem('shark.member.push-device')).toBeNull();
    expect(useWorkout.getState().clientId).toBeNull();
    // A device preference, not personal data: the next sign-in screen keeps it.
    expect(localStorage.getItem('shark.member.theme')).toBe('light');
  });
});

describe('session ended (401)', () => {
  it('keeps the queue and returns the same person to where they were', async () => {
    window.history.replaceState(null, '', '/app/progress?range=12');
    startOutbox(OWNER);
    await enqueue({ clientId: 'set-9', kind: 'workout-set', method: 'POST', path: '/member/training/workouts', body: {} });

    useSession.getState().expire();

    expect(useSession.getState()).toMatchObject({ status: 'signed-out', sessionEnded: true, viewer: null });
    expect(await pendingFor(OWNER)).toHaveLength(1);
    expect(takeReturnRoute('ten_shark:usr_someone_else')).toBeNull();
  });

  it('hands the route back only to the person whose session ended', () => {
    window.history.replaceState(null, '', '/app/messages/cnv_1');
    useSession.getState().expire();
    expect(takeReturnRoute(OWNER)).toBe('/messages/cnv_1');
    expect(takeReturnRoute(OWNER)).toBeNull();
  });

  it('keeps an unfinished workout for the same person, never for the next person at the phone', async () => {
    const workout = { clientId: 'w-aman', title: 'Push day', startedAt: Date.now(), exerciseIndex: 0, sets: [], restEndsAt: null };
    const signInAs = async (viewer: Viewer): Promise<void> => {
      send.mockImplementation((path: string) =>
        Promise.resolve(path === '/me' ? { viewer } : { items: [], activeBranchId: null }),
      );
      await useSession.getState().bootstrap();
    };

    // Aman's session ends mid-workout; Aman signs back in: the workout is still there.
    rememberLastOwner(OWNER);
    useWorkout.getState().start({ clientId: workout.clientId, assignmentId: null, programDayId: null, title: workout.title, sets: [] });
    localStorage.setItem('shark.workout.done.w0', '{}');
    useSession.getState().expire();
    await signInAs(aman);
    expect(useWorkout.getState().clientId).toBe('w-aman');
    expect(localStorage.getItem('shark.workout')).not.toBeNull();

    // It ends again, and somebody else signs in on this phone.
    useSession.getState().expire();
    await signInAs({ ...aman, userId: 'usr_priya', memberId: 'mem_priya', name: 'Priya' });
    expect(useWorkout.getState().clientId).toBeNull();
    expect(Object.keys(localStorage).filter((k) => k.startsWith('shark.workout'))).toEqual([]);
    // Aman's queued writes stay, under Aman, for when Aman is back.
    expect(lastOwner()).toBe('ten_shark:usr_priya');
  });

  it('a 401 while flushing leaves the write queued, not marked as a conflict', async () => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    send.mockRejectedValue(new ApiError(401, { error: { code: 'UNAUTHENTICATED', message: 'Sign in again', requestId: 'r' } }));
    startOutbox(OWNER);
    await enqueue({ clientId: 'set-5', kind: 'workout-set', method: 'POST', path: '/member/training/workouts', body: {} });
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    await vi.waitFor(async () => expect((await pendingFor(OWNER))[0]?.status).toBe('queued'));
  });
});

describe('offline start', () => {
  it('opens on the last person’s saved snapshot when /me cannot be reached', async () => {
    const { OfflineError } = await import('../api');
    queryClient.setQueryData(['home'], { greeting: 'saved' });
    await saveSnapshot(queryClient, useSession.getState());
    rememberLastOwner(OWNER);
    queryClient.clear();
    useSession.setState({ viewer: null, status: 'loading', offlineStart: false });
    send.mockRejectedValue(new OfflineError());

    await useSession.getState().bootstrap();

    expect(useSession.getState()).toMatchObject({ status: 'signed-in', offlineStart: true });
    expect(useSession.getState().viewer?.userId).toBe('usr_aman');
    expect(queryClient.getQueryData(['home'])).toEqual({ greeting: 'saved' });
  });

  it('stays signed out offline when nothing was saved for anyone', async () => {
    const { OfflineError } = await import('../api');
    useSession.setState({ viewer: null, status: 'loading', offlineStart: false });
    send.mockRejectedValue(new OfflineError());
    await useSession.getState().bootstrap();
    expect(useSession.getState().status).toBe('signed-out');
  });
});
