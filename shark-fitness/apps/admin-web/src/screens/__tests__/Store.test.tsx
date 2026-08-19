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

import StoreScreen from '../Store';
import { useAdmin } from '../../lib/store';

/* ============================================================================
   The Store shell.

   Three things live here that no single surface can be asked about: which tab
   is open (and whether the URL knows), which reads actually happen on arrival,
   and what each surface shows when its read fails. The last is the important
   one — every surface renders a list, and "the API is down" used to be
   indistinguishable from "there is nothing here".

   The route tree is rebuilt in miniature rather than importing the real one,
   because the real one drags twenty lazy screens and the console chrome into a
   component test. What matters is the shape: a pathless `console` layout with
   `/store` beneath it, so `useSearch({ from: '/console/store' })` resolves the
   same way it does in the app.
   ========================================================================= */

const STORE_TABS = ['register', 'inventory', 'orders', 'transfers', 'insights'] as const;
const STORE_WINDOWS = ['7d', '30d', '90d'] as const;

function buildRouter(initialUrl: string) {
  const rootRoute = createRootRoute({ component: Outlet });
  const consoleRoute = createRoute({ getParentRoute: () => rootRoute, id: 'console', component: Outlet });
  const storeRoute = createRoute({
    getParentRoute: () => consoleRoute,
    path: '/store',
    component: StoreScreen,
    validateSearch: (search: Record<string, unknown>) => ({
      tab: STORE_TABS.includes(search.tab as never) ? (search.tab as string) : 'register',
      window: STORE_WINDOWS.includes(search.window as never) ? (search.window as string) : '30d',
    }),
  });
  return createRouter({
    routeTree: rootRoute.addChildren([consoleRoute.addChildren([storeRoute])]),
    history: createMemoryHistory({ initialEntries: [initialUrl] }),
  });
}

function open(initialUrl = '/store') {
  const client = new QueryClient({
    mutationCache: new MutationCache({ onError: () => undefined }),
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const router = buildRouter(initialUrl);
  const result = render(
    <QueryClientProvider client={client}>
      {/* The miniature tree is structurally identical where it matters; the
          type parameter of the app's registered router is not. */}
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { ...result, router };
}

const owner = {
  userId: 'usr_1',
  tenantId: 'ten_1',
  role: 'owner',
  name: 'Priya Nair',
  permittedBranchIds: ['br_kor'],
} as unknown as Viewer;

const branch = { id: 'br_kor', name: 'Koramangala', timezone: 'Asia/Kolkata' } as Branch;

/** Answers every Store read with an empty but well-formed payload. */
const emptyStore = (path: string): Promise<unknown> => {
  if (path.startsWith('/admin/store/products')) {
    return Promise.resolve({ items: [], financial: { canSeeMargin: true, canSeeCost: true, restricted: [] } });
  }
  if (path.startsWith('/admin/store/transfers')) return Promise.resolve({ items: [] });
  if (path.startsWith('/admin/store/orders')) return Promise.resolve({ items: [] });
  if (path.startsWith('/admin/store/reports')) {
    return Promise.resolve({
      scope: { branchId: 'br_kor', branches: 1, from: '2026-07-19T00:00:00.000Z', to: '2026-08-18T00:00:00.000Z' },
      sales: { orders: 0, returns: 0, voided: 0, unitsSold: 0, revenueMinor: 0, taxMinor: 0 },
      margin: { revenueMinor: 0, costMinor: 0, marginMinor: 0, marginBp: 0 },
      valuation: { valuationMinor: 0, skus: 0 },
      shrinkage: { units: 0, costMinor: 0 },
      lowStock: [],
      topProducts: [],
      asOf: '2026-08-18T12:00:00.000Z',
      financial: { canSeeMargin: true, canSeeCost: true, restricted: [] },
    });
  }
  return Promise.resolve({ items: [] });
};

/** A rejection React Query will surface without tripping the unhandled guard. */
function refuse(message: string) {
  const rejected = Promise.reject(new Error(message));
  rejected.catch(() => undefined);
  return rejected;
}

const pathsCalled = (): string[] => apiMock.mock.calls.map(([path]) => String(path));

beforeEach(() => {
  useAdmin.setState({ viewer: owner, branches: [branch], activeBranchId: 'br_kor', status: 'signed-in' });
});

describe('Store — which surface is open', () => {
  it('opens the till by default', async () => {
    apiMock.mockImplementation(emptyStore);
    open();
    expect(await screen.findByRole('tab', { name: /Register/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('opens the surface named in the URL, so a link and a refresh both land', async () => {
    apiMock.mockImplementation(emptyStore);
    open('/store?tab=transfers');

    expect(await screen.findByRole('tab', { name: /Transfers/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Register/ })).toHaveAttribute('aria-selected', 'false');
  });

  it('puts the chosen surface in the URL rather than in state a reload forgets', async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation(emptyStore);
    const { router } = open();

    await user.click(await screen.findByRole('tab', { name: /Orders/ }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ tab: 'orders' }));
  });

  it('falls back to the till rather than a blank pane on a nonsense tab', async () => {
    apiMock.mockImplementation(emptyStore);
    open('/store?tab=accounting');
    // Search accumulates down the tree, so a validator that merely *omitted*
    // an unknown tab would let the pathless parent's raw value through and the
    // screen would render nothing at all. This is that regression.
    expect(await screen.findByRole('tab', { name: /Register/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('No sale in progress')).toBeInTheDocument();
  });
});

describe('Store — what it fetches on arrival', () => {
  it('does not run the sales history or the whole report to open a till', async () => {
    apiMock.mockImplementation(emptyStore);
    open();
    await screen.findByRole('tab', { name: /Register/ });

    // The catalogue is what the till sells from, and the transfer list feeds
    // the count in the tab strip. The report is a ledger scan over every
    // product at every branch in scope, and the history is up to 500 orders;
    // neither has any business running before their surface is asked for.
    await waitFor(() => expect(pathsCalled().some((p) => p.startsWith('/admin/store/products'))).toBe(true));
    expect(pathsCalled().some((p) => p.startsWith('/admin/store/reports'))).toBe(false);
    expect(pathsCalled().some((p) => p.startsWith('/admin/store/orders'))).toBe(false);
  });

  it('fetches the sales history when Orders is opened', async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation(emptyStore);
    open();

    await user.click(await screen.findByRole('tab', { name: /Orders/ }));
    await waitFor(() => expect(pathsCalled().some((p) => p.startsWith('/admin/store/orders'))).toBe(true));
  });
});

describe('Store — a failed read is not an empty shop', () => {
  it('says the sales history could not be read instead of "No sales yet"', async () => {
    apiMock.mockImplementation((path: string) =>
      path.startsWith('/admin/store/orders') ? refuse('boom') : emptyStore(path),
    );
    open('/store?tab=orders');

    expect(await screen.findByText('Could not load the sales history')).toBeInTheDocument();
    expect(screen.getByText(/the sales are there and could not be read/)).toBeInTheDocument();
    expect(screen.queryByText('No sales yet')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('retries the failed read rather than only apologising for it', async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation((path: string) =>
      path.startsWith('/admin/store/orders') ? refuse('boom') : emptyStore(path),
    );
    open('/store?tab=orders');

    await screen.findByText('Could not load the sales history');
    apiMock.mockImplementation(emptyStore);
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('No sales yet')).toBeInTheDocument();
  });

  it('says transfers could not be read instead of "Nothing in transit"', async () => {
    apiMock.mockImplementation((path: string) =>
      path.startsWith('/admin/store/transfers') ? refuse('boom') : emptyStore(path),
    );
    open('/store?tab=transfers');

    expect(await screen.findByText('Could not load transfers')).toBeInTheDocument();
    expect(screen.queryByText('Nothing in transit')).not.toBeInTheDocument();
  });

  it('never renders a failed report as a shop that took nothing', async () => {
    apiMock.mockImplementation((path: string) =>
      path.startsWith('/admin/store/reports') ? refuse('boom') : emptyStore(path),
    );
    open('/store?tab=insights');

    expect(await screen.findByText('Could not load the figures')).toBeInTheDocument();
    // Zero takings is a real and answerable figure. It must never stand in for
    // "the request failed" (PF-RPT-005).
    expect(screen.getByText(/Nothing here is a zero/)).toBeInTheDocument();
  });

  it('refuses to open a till whose catalogue did not load', async () => {
    apiMock.mockImplementation((path: string) =>
      path.startsWith('/admin/store/products') ? refuse('boom') : emptyStore(path),
    );
    open();

    expect(await screen.findByText('Could not open the till')).toBeInTheDocument();
    expect(screen.getByText(/Nothing has been sold and no stock has moved/)).toBeInTheDocument();
    expect(screen.queryByText('No sale in progress')).not.toBeInTheDocument();
  });

  it('keeps one failing surface from poisoning the others', async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation((path: string) =>
      path.startsWith('/admin/store/orders') ? refuse('boom') : emptyStore(path),
    );
    open('/store?tab=orders');

    await screen.findByText('Could not load the sales history');
    await user.click(screen.getByRole('tab', { name: /Inventory/ }));

    expect(await screen.findByText('Nothing matches')).toBeInTheDocument();
    expect(screen.queryByText('Could not load the sales history')).not.toBeInTheDocument();
  });
});

describe('Store — permission', () => {
  it('tells a role without inventory.view that the module is not theirs', async () => {
    useAdmin.setState({ viewer: { ...owner, role: 'trainer' } as Viewer });
    apiMock.mockImplementation(emptyStore);
    open();

    expect(await screen.findByText('Not available to your role')).toBeInTheDocument();
    // A denial is not an empty shop either, and it costs no requests to say so.
    expect(pathsCalled()).toHaveLength(0);
  });
});
