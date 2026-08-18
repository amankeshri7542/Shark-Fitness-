import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Viewer } from '@shark/contracts';

const apiMock = vi.hoisted(() => vi.fn());
const authClear = vi.hoisted(() => vi.fn());

vi.mock('../api', () => ({
  api: apiMock,
  auth: { get: () => 'cookie-session', set: () => undefined, clear: authClear },
  ApiError: class ApiError extends Error {},
}));

import { useAdmin } from '../store';

const staff = (role: Viewer['role']): Viewer =>
  ({
    userId: 'usr_1',
    tenantId: 'ten_1',
    role,
    permittedBranchIds: ['brn_1'],
  }) as Viewer;

const branch = (id: string, name: string) => ({ id, name }) as never;

describe('admin session bootstrap', () => {
  beforeEach(() => {
    apiMock.mockReset();
    authClear.mockReset();
    useAdmin.setState({ viewer: null, branches: [], activeBranchId: null, status: 'loading' });
  });

  it('signs a staff viewer in and keeps their branches', async () => {
    apiMock
      .mockResolvedValueOnce({ viewer: staff('owner') })
      .mockResolvedValueOnce({ items: [branch('brn_1', 'Koramangala'), branch('brn_2', 'HSR')], activeBranchId: null });

    await useAdmin.getState().bootstrap();

    const state = useAdmin.getState();
    expect(state.status).toBe('signed-in');
    expect(state.branches).toHaveLength(2);
  });

  it('leaves a multi-branch viewer on the all-branches view', async () => {
    apiMock
      .mockResolvedValueOnce({ viewer: staff('regional_manager') })
      .mockResolvedValueOnce({ items: [branch('brn_1', 'Koramangala'), branch('brn_2', 'HSR')], activeBranchId: null });

    await useAdmin.getState().bootstrap();

    // Defaulting to one location would quietly hide the rest of the region.
    expect(useAdmin.getState().activeBranchId).toBeNull();
  });

  it('selects the only branch a single-branch viewer can see', async () => {
    apiMock
      .mockResolvedValueOnce({ viewer: staff('reception') })
      .mockResolvedValueOnce({ items: [branch('brn_1', 'Koramangala')], activeBranchId: null });

    await useAdmin.getState().bootstrap();

    expect(useAdmin.getState().activeBranchId).toBe('brn_1');
  });

  it('refuses a member session instead of showing an empty console', async () => {
    apiMock.mockResolvedValueOnce({ viewer: staff('member') });

    await useAdmin.getState().bootstrap();

    const state = useAdmin.getState();
    expect(state.status).toBe('signed-out');
    expect(state.viewer).toBeNull();
    expect(authClear).toHaveBeenCalled();
    // It must stop before asking for branches a member has no business seeing.
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it('signs out when the session lookup fails', async () => {
    apiMock.mockRejectedValueOnce(new Error('401'));

    await useAdmin.getState().bootstrap();

    expect(useAdmin.getState().status).toBe('signed-out');
    expect(authClear).toHaveBeenCalled();
  });

  it('signs out when the branch lookup fails after a valid viewer', async () => {
    apiMock
      .mockResolvedValueOnce({ viewer: staff('owner') })
      .mockRejectedValueOnce(new Error('500'));

    await useAdmin.getState().bootstrap();

    // A half-loaded console is worse than a clean sign-out.
    expect(useAdmin.getState().status).toBe('signed-out');
    expect(useAdmin.getState().viewer).toBeNull();
  });

  it('clears the session locally even when the sign-out call fails', async () => {
    apiMock
      .mockResolvedValueOnce({ viewer: staff('owner') })
      .mockResolvedValueOnce({ items: [branch('brn_1', 'Koramangala')], activeBranchId: null });
    await useAdmin.getState().bootstrap();
    expect(useAdmin.getState().status).toBe('signed-in');

    apiMock.mockRejectedValueOnce(new Error('network'));
    await useAdmin.getState().signOut();

    expect(useAdmin.getState().status).toBe('signed-out');
    expect(useAdmin.getState().branches).toEqual([]);
    expect(useAdmin.getState().activeBranchId).toBeNull();
  });
});
