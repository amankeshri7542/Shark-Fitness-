import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiMock = vi.hoisted(() => vi.fn());

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, api: apiMock };
});

vi.mock('../../lib/store', () => ({
  usePermission: () => true,
  useBranchScope: () => ({ branchId: 'br_kor', branchName: 'Koramangala Depot' }),
  useBranchTimeZone: () => 'Asia/Kolkata',
}));

vi.mock('../../lib/realtime', () => ({ useOnline: () => true }));

vi.mock('../../ui/shell', () => ({
  Page: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import FloorScreen from '../Floor';

const refusal = {
  checkInId: 'chk_refused',
  memberId: 'mbr_rohit',
  memberNo: 'SF-40188',
  name: 'Rohit Bhaskar',
  initials: 'RB',
  method: 'staff',
  decision: 'denied_grace_outstanding',
  granted: false,
  canOverride: true,
  enteredAt: '2026-10-22T12:00:00.000Z',
  exitedAt: null,
  durationMin: null,
  autoClosed: false,
  inside: false,
  overrideByName: null,
  overrideReason: null,
  visitNumber: null,
};

function routeApi(feedItems: unknown[]) {
  apiMock.mockImplementation((raw: unknown) => {
    const path = String(raw);
    if (path.startsWith('/admin/attendance/current')) {
      return Promise.resolve({ at: '2026-10-22T12:00:00.000Z', totals: { inside: 0, capacity: 120 }, branches: [], items: [] });
    }
    if (path.startsWith('/admin/attendance/search')) {
      return Promise.resolve({
        items: [{ memberId: 'mbr_rohit', memberNo: 'SF-40188', name: 'Rohit Bhaskar', initials: 'RB', homeBranchId: 'br_kor', lifecycle: 'grace', insideSince: null }],
      });
    }
    if (path === '/admin/attendance/check-in') {
      return Promise.resolve({
        granted: false,
        decision: 'denied_grace_outstanding',
        checkInId: 'chk_refused',
        canOverride: true,
        message: 'There is an unpaid balance on your account. Settle it here or at reception to get back in.',
        member: { name: 'Rohit Bhaskar' },
        replayed: false,
      });
    }
    if (path.startsWith('/admin/attendance?')) {
      return Promise.resolve({ date: null, filter: 'all', total: feedItems.length, hasMore: false, breakdown: {}, items: feedItems });
    }
    return Promise.resolve({});
  });
}

function renderFloor() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <FloorScreen />
    </QueryClientProvider>,
  );
}

describe('desk check-in refusal', () => {
  beforeEach(() => apiMock.mockReset());

  it('tells the desk who was refused and why, and opens the override', async () => {
    let feed: unknown[] = [];
    routeApi(feed);
    const user = userEvent.setup();
    renderFloor();

    await user.type(await screen.findByPlaceholderText(/name, member number or phone/i), 'Rohit');
    const result = await screen.findByText('Rohit Bhaskar');
    feed = [refusal];
    routeApi(feed);
    await user.click(within(result.closest('li')!).getByRole('button', { name: /check in/i }));

    expect(await screen.findByText(/Rohit Bhaskar was refused: Balance outstanding\./)).toBeInTheDocument();
    // The member-facing sentence is for the member's phone, not the desk.
    expect(screen.queryByText(/your account/i)).not.toBeInTheDocument();
    expect(await screen.findByText(/This lets Rohit Bhaskar in against the refusal/)).toBeInTheDocument();
  });
});
