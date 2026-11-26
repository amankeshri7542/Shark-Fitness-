import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Viewer } from '@shark/contracts';

const doubles = vi.hoisted(() => ({
  api: vi.fn(),
  authClear: vi.fn(),
  authGet: vi.fn(() => 'cookie-session'),
}));

const offline = vi.hoisted(() => class OfflineError extends Error {});

vi.mock('../api', () => ({
  api: doubles.api,
  OfflineError: offline,
  auth: {
    clear: doubles.authClear,
    get: doubles.authGet,
  },
}));

import { useSession } from '../store';

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

  it('remembers a confirmed member session, and an offline reload resumes it (P05, PF-WORK-005)', async () => {
    localStorage.clear();
    doubles.api.mockResolvedValueOnce({ viewer: MEMBER_VIEWER }).mockResolvedValueOnce({ items: BRANCHES, activeBranchId: null });
    await useSession.getState().bootstrap();
    expect(useSession.getState().status).toBe('signed-in');

    useSession.setState({ viewer: null, branches: [], activeBranchId: null, status: 'loading' });
    doubles.api.mockReset().mockRejectedValue(new offline('No connection'));
    await useSession.getState().bootstrap();
    expect(useSession.getState()).toMatchObject({ status: 'signed-in', viewer: { userId: 'usr_aman' }, activeBranchId: 'br_kor' });
    expect(doubles.authClear).not.toHaveBeenCalled();
  });

  it('offline with nothing remembered is signed out, as before', async () => {
    localStorage.clear();
    doubles.api.mockRejectedValue(new offline('No connection'));
    await useSession.getState().bootstrap();
    expect(useSession.getState().status).toBe('signed-out');
  });

  it('a refused session is signed out and forgotten even if one was remembered', async () => {
    localStorage.setItem('shark.member.session', JSON.stringify({ viewer: MEMBER_VIEWER, branches: BRANCHES, activeBranchId: 'br_kor' }));
    doubles.api.mockRejectedValue(new Error('401'));
    await useSession.getState().bootstrap();
    expect(useSession.getState().status).toBe('signed-out');
    expect(localStorage.getItem('shark.member.session')).toBeNull();
  });

  it("never resumes another person's remembered session when /me named someone else", async () => {
    localStorage.setItem('shark.member.session', JSON.stringify({ viewer: MEMBER_VIEWER, branches: BRANCHES, activeBranchId: 'br_kor' }));
    const other = { ...MEMBER_VIEWER, userId: 'usr_riya', name: 'Riya' } as Viewer;
    doubles.api.mockResolvedValueOnce({ viewer: other }).mockRejectedValueOnce(new offline('No connection'));
    await useSession.getState().bootstrap();
    expect(useSession.getState().viewer?.userId).not.toBe('usr_aman');
    expect(localStorage.getItem('shark.member.session')).toBeNull();
  });

  it("signing out forgets the member's offline exercise library (their last weights)", async () => {
    localStorage.setItem('shark.exercise.library', JSON.stringify([{ id: 'ex_squat', lastPerformance: '100 kg × 5' }]));
    doubles.api.mockResolvedValue({});
    await useSession.getState().signOut();
    expect(localStorage.getItem('shark.exercise.library')).toBeNull();
  });
});
