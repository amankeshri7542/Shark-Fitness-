import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Viewer } from '@shark/contracts';

const doubles = vi.hoisted(() => ({
  api: vi.fn(),
  authClear: vi.fn(),
  authGet: vi.fn(() => 'cookie-session'),
}));

vi.mock('../api', () => ({
  api: doubles.api,
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
});
