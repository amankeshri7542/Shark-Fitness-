import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import type { Branch, Viewer } from '@shark/contracts';

const apiMock = vi.hoisted(() => vi.fn());

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, api: apiMock };
});

import ReportsScreen from '../Reports';
import { useAdmin } from '../../lib/store';
import { meta, revenue } from '../reports/__tests__/harness';

/* ============================================================================
   The Reports shell.

   Which report, which range and which branch all live in the URL, because a
   report is something people send each other: "revenue, Koramangala, last
   month" has to survive being pasted into a message. The rest of what lives
   here is refusal — a role without the permission, an export a role may not
   run, and a failed read that must never render as a quiet zero.
   ========================================================================= */

const TABS = ['revenue', 'membership', 'attendance', 'trainer', 'retention'] as const;

function buildRouter(initialUrl: string) {
  const rootRoute = createRootRoute({ component: Outlet });
  const consoleRoute = createRoute({ getParentRoute: () => rootRoute, id: 'console', component: Outlet });
  const reportsRoute = createRoute({
    getParentRoute: () => consoleRoute,
    path: '/reports',
    component: ReportsScreen,
    validateSearch: (search: Record<string, unknown>) => ({
      tab: TABS.includes(search.tab as never) ? (search.tab as string) : 'revenue',
      ...(typeof search.from === 'string' ? { from: search.from } : {}),
      ...(typeof search.to === 'string' ? { to: search.to } : {}),
      ...(typeof search.branchId === 'string' && search.branchId ? { branchId: search.branchId } : {}),
    }),
  });
  return createRouter({
    routeTree: rootRoute.addChildren([consoleRoute.addChildren([reportsRoute])]),
    history: createMemoryHistory({ initialEntries: [initialUrl] }),
  });
}

function open(initialUrl = '/reports') {
  const client = new QueryClient({
    mutationCache: new MutationCache({ onError: () => undefined }),
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const router = buildRouter(initialUrl);
  const result = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { ...result, router };
}

/* The console derives permissions from the role, so these are roles rather
   than permission lists — and the three that matter are genuinely different
   people: an owner holds everything, a branch manager may read reports and
   export them but not see money, and platform support may read them and not
   export. A trainer holds no reporting permission at all. */
const viewerAs = (role: string): Viewer =>
  ({
    userId: 'usr_1',
    tenantId: 'ten_1',
    role,
    name: 'Vikas Menon',
    permittedBranchIds: ['br_kor'],
  }) as unknown as Viewer;

const owner = viewerAs('owner');
const branch = { id: 'br_kor', name: 'Koramangala Depot', timezone: 'Asia/Kolkata' } as Branch;

const paths = (): string[] => apiMock.mock.calls.map(([p]) => String(p));

/** Each report has its own shape; answer by path rather than by one blanket
 *  mock, or a surface gets handed another surface's payload and throws. */
const answer = (path: string): Promise<unknown> => {
  if (path.startsWith('/admin/reports/revenue')) return Promise.resolve(revenue());
  if (path.startsWith('/admin/reports/retention')) {
    return Promise.resolve({ meta: meta(), bands: { high: 0, watch: 0, low: 0 }, cohorts: [], atRiskValueMinor: null });
  }
  if (path.startsWith('/admin/reports/trainer')) return Promise.resolve({ meta: meta(), rows: [] });
  if (path.startsWith('/admin/reports/membership')) {
    return Promise.resolve({
      meta: meta(),
      joins: { value: 0, previous: null, changeBp: null },
      cancellations: { value: 0, previous: null, changeBp: null },
      freezes: { value: 0, previous: null, changeBp: null },
      renewals: { value: 0, previous: null, changeBp: null },
      activeAtEnd: 0,
      churnBp: null,
      netChange: 0,
      ltvMinor: null,
      series: [],
      byProduct: [],
    });
  }
  return Promise.resolve({
    meta: meta(),
    visits: { value: 0, previous: null, changeBp: null },
    uniqueMembers: { value: 0, previous: null, changeBp: null },
    noShows: { value: 0, previous: null, changeBp: null },
    noShowRateBp: null,
    occupancyBp: null,
    series: [],
    byHour: Array.from({ length: 24 }, (_u, hour) => ({ hour, visits: 0 })),
    byBranch: [],
  });
};

beforeEach(() => {
  useAdmin.setState({ viewer: owner, branches: [branch], activeBranchId: 'br_kor', status: 'signed-in' });
  apiMock.mockImplementation(answer);
});

describe('Reports — permission', () => {
  it('refuses the module to a role without report.view, and spends no request saying so', async () => {
    useAdmin.setState({ viewer: viewerAs('trainer') });
    open();
    expect(await screen.findByText(/Reports and analytics/)).toBeInTheDocument();
    // A refusal is decided from the role, not from a round trip.
    expect(paths()).toHaveLength(0);
  });

  it('offers the export only to a role that holds report.export', async () => {
    // Platform support may read a report and may not walk out with it.
    useAdmin.setState({ viewer: viewerAs('platform_support') });
    open();
    expect(await screen.findByRole('button', { name: /Export not permitted/ })).toBeDisabled();
  });

  it('offers a working export to a role that holds it', async () => {
    open();
    expect(await screen.findByRole('button', { name: 'Export CSV' })).toBeInTheDocument();
  });
});

describe('Reports — the URL carries the report', () => {
  it('opens revenue by default', async () => {
    open();
    expect(await screen.findByRole('tab', { name: 'Revenue' })).toHaveAttribute('aria-selected', 'true');
  });

  it('opens the report named in the URL', async () => {
    open('/reports?tab=trainer');
    expect(await screen.findByRole('tab', { name: 'Coaches' })).toHaveAttribute('aria-selected', 'true');
  });

  it('falls back to revenue rather than a blank pane on a nonsense report', async () => {
    open('/reports?tab=astrology');
    expect(await screen.findByRole('tab', { name: 'Revenue' })).toHaveAttribute('aria-selected', 'true');
  });

  it('puts the chosen report in the URL so it can be sent to somebody', async () => {
    const user = userEvent.setup();
    const { router } = open();

    await user.click(await screen.findByRole('tab', { name: 'Retention' }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ tab: 'retention' }));
  });

  it('carries the range in the URL, so a reload lands on the same numbers', async () => {
    open('/reports?tab=revenue&from=2026-07-01&to=2026-07-31');
    await waitFor(() => expect(paths().length).toBeGreaterThan(0));
    // The range on the wire is the range in the URL, not a default that would
    // quietly show somebody a different month than the link they followed.
    expect(paths()[0]).toContain('from=2026-07-01');
    expect(paths()[0]).toContain('to=2026-07-31');
  });

  it('sends a branch filter only when one is chosen', async () => {
    open('/reports?tab=revenue');
    await waitFor(() => expect(paths().length).toBeGreaterThan(0));
    // No branch means every branch the caller may see, which is the absence of
    // the parameter rather than a value.
    expect(paths()[0]).not.toContain('branchId');
  });

  it('scopes to one branch when the URL names one', async () => {
    open('/reports?tab=revenue&branchId=br_kor');
    await waitFor(() => expect(paths().length).toBeGreaterThan(0));
    expect(paths()[0]).toContain('branchId=br_kor');
  });
});

describe('Reports — a failed read is never a quiet zero', () => {
  it('says the report could not be read instead of showing nothing earned', async () => {
    const { ApiError } = await import('../../lib/api');
    apiMock.mockImplementation(() => {
      const rejected = Promise.reject(
        new ApiError(500, { error: { code: 'INTERNAL', message: 'The query failed.', requestId: 'req_9' } }),
      );
      rejected.catch(() => undefined);
      return rejected;
    });
    open();

    expect(await screen.findByText('That report could not be read')).toBeInTheDocument();
    // "Revenue: ₹0.00" on a failed read is the single most damaging sentence
    // this screen could print.
    expect(screen.queryByText('₹0.00')).not.toBeInTheDocument();
  });

  it('recovers on retry', async () => {
    const user = userEvent.setup();
    const { ApiError } = await import('../../lib/api');
    apiMock.mockImplementationOnce(() => {
      const rejected = Promise.reject(
        new ApiError(500, { error: { code: 'INTERNAL', message: 'The query failed.', requestId: 'req_9' } }),
      );
      rejected.catch(() => undefined);
      return rejected;
    });
    apiMock.mockImplementation(answer);
    open();

    await user.click(await screen.findByRole('button', { name: /Retry|Try again/ }));
    await waitFor(() => expect(screen.queryByText('That report could not be read')).not.toBeInTheDocument());
  });
});
