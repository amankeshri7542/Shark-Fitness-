import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Viewer } from '@shark/contracts';

const doubles = vi.hoisted(() => ({
  api: vi.fn(),
  authClear: vi.fn(),
  authGet: vi.fn(() => 'cookie-session'),
}));

vi.mock('../api', async (original) => ({
  ...(await original<typeof import('../api')>()),
  api: doubles.api,
  auth: {
    clear: doubles.authClear,
    get: doubles.authGet,
  },
}));

import { OfflineError } from '../api';
import { deleteSnapshot, rememberLastOwner, snapshotOwners } from '../persisted-cache';
import { useSession } from '../store';

const offline = OfflineError;

const STAFF_VIEWER = {
  userId: 'usr_owner',
  tenantId: 'ten_shark',
  name: 'Owner',
  role: 'owner',
  permittedBranchIds: ['br_kor'],
} as Viewer;

describe('member session bootstrap', () => {
  beforeEach(() => {
    doubles.api.mockReset();
    doubles.authClear.mockReset();
    doubles.authGet.mockReset().mockReturnValue('cookie-session');
    useSession.setState({
      viewer: null,
      branches: [],
      activeBranchId: null,
      status: 'loading',
    });
  });

  it('rejects a valid staff session before requesting member-only data', async () => {
    doubles.api.mockResolvedValueOnce({ viewer: STAFF_VIEWER });

    await useSession.getState().bootstrap();

    expect(doubles.api).toHaveBeenCalledTimes(1);
    expect(doubles.authClear).toHaveBeenCalledTimes(1);
    expect(useSession.getState()).toMatchObject({
      viewer: null,
      branches: [],
      activeBranchId: null,
      status: 'signed-out',
    });
  });

  const MEMBER_VIEWER = { userId: 'usr_aman', tenantId: 'ten_shark', name: 'Aman', role: 'member', homeBranchId: 'br_kor', permittedBranchIds: ['br_kor'] } as unknown as Viewer;
  const BRANCHES = [{ id: 'br_kor', name: 'Koramangala' }];

  // P05 kept the last confirmed session in localStorage; since the P04/P05
  // integration the same guarantee comes from P04's per-person snapshot in
  // IndexedDB, written as soon as a session is confirmed. The behaviour these
  // tests prove is unchanged.
  async function forgetEverything(): Promise<void> {
    localStorage.clear();
    for (const owner of await snapshotOwners()) await deleteSnapshot(owner);
    rememberLastOwner(null);
  }

  it('remembers a confirmed member session, and an offline reload resumes it (P05, PF-WORK-005)', async () => {
    await forgetEverything();
    doubles.api.mockResolvedValueOnce({ viewer: MEMBER_VIEWER }).mockResolvedValueOnce({ items: BRANCHES, activeBranchId: null });
    await useSession.getState().bootstrap();
    expect(useSession.getState().status).toBe('signed-in');
    await vi.waitFor(async () => expect(await snapshotOwners()).toContain('ten_shark:usr_aman'));

    useSession.setState({ viewer: null, branches: [], activeBranchId: null, status: 'loading' });
    doubles.api.mockReset().mockRejectedValue(new offline());
    await useSession.getState().bootstrap();
    expect(useSession.getState()).toMatchObject({ status: 'signed-in', viewer: { userId: 'usr_aman' }, activeBranchId: 'br_kor' });
    expect(doubles.authClear).not.toHaveBeenCalled();
  });

  it('offline with nothing remembered is signed out, as before', async () => {
    await forgetEverything();
    doubles.api.mockRejectedValue(new offline());
    await useSession.getState().bootstrap();
    expect(useSession.getState().status).toBe('signed-out');
  });

  async function rememberAman(): Promise<void> {
    await forgetEverything();
    doubles.api.mockResolvedValueOnce({ viewer: MEMBER_VIEWER }).mockResolvedValueOnce({ items: BRANCHES, activeBranchId: null });
    await useSession.getState().bootstrap();
    await vi.waitFor(async () => expect(await snapshotOwners()).toContain('ten_shark:usr_aman'));
    useSession.setState({ viewer: null, branches: [], activeBranchId: null, status: 'loading' });
    doubles.api.mockReset();
  }

  it('a refused session is signed out and forgotten even if one was remembered', async () => {
    await rememberAman();
    doubles.api.mockRejectedValue(new Error('401'));
    await useSession.getState().bootstrap();
    expect(useSession.getState().status).toBe('signed-out');
    expect(await snapshotOwners()).not.toContain('ten_shark:usr_aman');
  });

  it("never resumes another person's remembered session when /me named someone else", async () => {
    await rememberAman();
    const other = { ...MEMBER_VIEWER, userId: 'usr_riya', name: 'Riya' } as Viewer;
    doubles.api.mockResolvedValueOnce({ viewer: other }).mockRejectedValueOnce(new offline());
    await useSession.getState().bootstrap();
    expect(useSession.getState().viewer?.userId).not.toBe('usr_aman');
    expect(useSession.getState().status).toBe('signed-out');
  });

  it("signing out forgets the member's offline exercise library (their last weights)", async () => {
    localStorage.setItem('shark.exercise.library', JSON.stringify([{ id: 'ex_squat', lastPerformance: '100 kg × 5' }]));
    doubles.api.mockResolvedValue({});
    await useSession.getState().signOut();
    expect(localStorage.getItem('shark.exercise.library')).toBeNull();
  });
});
