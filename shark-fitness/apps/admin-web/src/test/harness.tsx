import { render } from '@testing-library/react';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  type AnyRoute,
} from '@tanstack/react-router';
import type { Branch, Role, Viewer } from '@shark/contracts';
import { useAdmin } from '../lib/store';

/**
 * Renders one console screen at a URL inside a real (memory) router and a
 * fresh query client, for component tests of the P07 screens.
 */
export interface RenderedScreen {
  router: { state: { location: { pathname: string; search: Record<string, unknown> } } };
  client: QueryClient;
  container: HTMLElement;
  unmount: () => void;
}

export function renderScreen(
  initialUrl: string,
  screens: Array<{ path: string; component: () => React.ReactNode; validateSearch?: (s: Record<string, unknown>) => Record<string, unknown> }>,
): RenderedScreen {
  const client = new QueryClient({
    mutationCache: new MutationCache({ onError: () => undefined }),
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const consoleRoute = createRoute({ getParentRoute: () => rootRoute, id: 'console', component: Outlet });
  const children: AnyRoute[] = screens.map((s) =>
    createRoute({
      getParentRoute: () => consoleRoute,
      path: s.path,
      component: s.component,
      ...(s.validateSearch ? { validateSearch: s.validateSearch } : {}),
    }) as unknown as AnyRoute,
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren([consoleRoute.addChildren(children)]),
    history: createMemoryHistory({ initialEntries: [initialUrl] }),
  });
  const result = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { container: result.container, unmount: result.unmount, router: router as unknown as RenderedScreen['router'], client };
}

export const KORAMANGALA = { id: 'br_kor', name: 'Koramangala', timezone: 'Asia/Kolkata' } as Branch;

/** Signs the store in as a role at Koramangala. */
export function signInAs(role: Role, extra: Partial<Viewer> = {}): void {
  useAdmin.setState({
    viewer: {
      userId: 'usr_test',
      tenantId: 'ten_shark',
      role,
      name: 'Test Person',
      initials: 'TP',
      permittedBranchIds: ['br_kor'],
      ...extra,
    } as unknown as Viewer,
    branches: [KORAMANGALA],
    activeBranchId: 'br_kor',
    status: 'signed-in',
  });
}

/** A promise that rejects without an unhandled-rejection warning. */
export function refuse(error: Error): Promise<never> {
  const rejected = Promise.reject(error);
  rejected.catch(() => undefined);
  return rejected;
}

export function setOnline(value: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => value });
}
