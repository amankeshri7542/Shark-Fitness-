import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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

import SupportScreen from '../Support';
import { useAdmin } from '../../lib/store';
import { queue, retention } from '../support/__tests__/harness';

/* ============================================================================
   The Support shell.

   Three things live here that no single surface can be asked about: which tab
   is open (and whether the URL knows), which reads happen on arrival, and what
   each surface shows when its read fails. The last matters most on this module
   — "Nothing in the queue" on a morning with nine breaching tickets is the
   single most damaging sentence this screen could print.
   ========================================================================= */

const SUPPORT_TABS = ['queue', 'feedback', 'retention'] as const;

function buildRouter(initialUrl: string) {
  const rootRoute = createRootRoute({ component: Outlet });
  const consoleRoute = createRoute({ getParentRoute: () => rootRoute, id: 'console', component: Outlet });
  const supportRoute = createRoute({
    getParentRoute: () => consoleRoute,
    path: '/support',
    component: SupportScreen,
    validateSearch: (search: Record<string, unknown>) => ({
      tab: SUPPORT_TABS.includes(search.tab as never) ? (search.tab as string) : 'queue',
      ...(typeof search.ticket === 'string' && search.ticket.length > 0 ? { ticket: search.ticket } : {}),
    }),
  });
  return createRouter({
    routeTree: rootRoute.addChildren([consoleRoute.addChildren([supportRoute])]),
    history: createMemoryHistory({ initialEntries: [initialUrl] }),
  });
}

function open(initialUrl = '/support') {
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

const owner = {
  userId: 'usr_1',
  tenantId: 'ten_1',
  role: 'owner',
  name: 'Vikas Menon',
  permittedBranchIds: ['br_kor'],
} as unknown as Viewer;

const branch = { id: 'br_kor', name: 'Koramangala Depot', timezone: 'Asia/Kolkata' } as Branch;

const emptyFeedback = {
  items: [],
  nps: { responses: 0, promoters: 0, passives: 0, detractors: 0, score: null },
  csat: { responses: 0, average: null, satisfiedPct: null },
  cancellationReasons: [],
  classRating: null,
  trainerRating: null,
  anonymousCount: 0,
  asOf: '2026-08-19T04:00:00.000Z',
};

const answer = (path: string): Promise<unknown> => {
  if (path.startsWith('/admin/support/tickets')) return Promise.resolve(queue());
  if (path.startsWith('/admin/support/feedback')) return Promise.resolve(emptyFeedback);
  if (path.startsWith('/admin/support/retention')) return Promise.resolve(retention());
  return Promise.resolve({ items: [] });
};

function refuse(message: string) {
  const rejected = Promise.reject(new Error(message));
  rejected.catch(() => undefined);
  return rejected;
}

const pathsCalled = (): string[] => apiMock.mock.calls.map(([path]) => String(path));

beforeEach(() => {
  useAdmin.setState({ viewer: owner, branches: [branch], activeBranchId: 'br_kor', status: 'signed-in' });
});

describe('Support — which surface is open', () => {
  it('opens the queue by default, because that is the work', async () => {
    apiMock.mockImplementation(answer);
    open();
    expect(await screen.findByRole('tab', { name: /Queue/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('opens the surface named in the URL', async () => {
    apiMock.mockImplementation(answer);
    open('/support?tab=retention');
    expect(await screen.findByRole('tab', { name: /Retention/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('falls back to the queue rather than a blank pane on a nonsense tab', async () => {
    // Search accumulates down the pathless console layout, so a validator that
    // merely omitted an unknown tab would let the raw value through.
    apiMock.mockImplementation(answer);
    open('/support?tab=accounting');
    expect(await screen.findByRole('tab', { name: /Queue/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('puts the chosen surface in the URL so a reload lands back on it', async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation(answer);
    const { router } = open();

    await user.click(await screen.findByRole('tab', { name: /Feedback/ }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ tab: 'feedback' }));
  });

  it('deep-links straight to a ticket, so a breach alert can point at one', async () => {
    apiMock.mockImplementation((path: string) =>
      path.startsWith('/admin/support/tickets/') ? refuse('detail not needed here') : answer(path),
    );
    open('/support?tab=queue&ticket=tkt_1');
    // The drawer opens on arrival rather than needing somebody to find the row.
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});

describe('Support — what it fetches on arrival', () => {
  it('does not recompute everyone’s churn risk to show a ticket queue', async () => {
    apiMock.mockImplementation(answer);
    open();
    await screen.findByRole('tab', { name: /Queue/ });

    await waitFor(() => expect(pathsCalled().some((p) => p.startsWith('/admin/support/tickets'))).toBe(true));
    // The retention read walks the check-in, payment and membership history of
    // every member in scope. Running it to render a queue would be the most
    // expensive thing this console does, for nothing.
    expect(pathsCalled().some((p) => p.startsWith('/admin/support/retention'))).toBe(false);
    expect(pathsCalled().some((p) => p.startsWith('/admin/support/feedback'))).toBe(false);
  });

  it('loads retention when the surface is opened', async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation(answer);
    open();

    await user.click(await screen.findByRole('tab', { name: /Retention/ }));
    await waitFor(() => expect(pathsCalled().some((p) => p.startsWith('/admin/support/retention'))).toBe(true));
  });
});

describe('Support — a failed read is not an empty desk', () => {
  it('says the queue could not be read instead of "nothing in the queue"', async () => {
    apiMock.mockImplementation((path: string) =>
      path.startsWith('/admin/support/tickets') ? refuse('boom') : answer(path),
    );
    open();

    expect(await screen.findByText('Could not load the queue')).toBeInTheDocument();
    expect(screen.getByText(/This is not an empty desk/)).toBeInTheDocument();
    expect(screen.queryByText('Nothing in the queue')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('recovers on retry', async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation((path: string) =>
      path.startsWith('/admin/support/tickets') ? refuse('boom') : answer(path),
    );
    open();

    await screen.findByText('Could not load the queue');
    apiMock.mockImplementation(answer);
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('button', { name: 'SUP-1051' })).toBeInTheDocument();
  });

  it('never reports a failed retention read as nobody being at risk', async () => {
    apiMock.mockImplementation((path: string) =>
      path.startsWith('/admin/support/retention') ? refuse('boom') : answer(path),
    );
    open('/support?tab=retention');

    expect(await screen.findByText('Could not work out who is at risk')).toBeInTheDocument();
    expect(screen.getByText(/would mean nobody is at risk, which is not what happened/)).toBeInTheDocument();
  });

  it('keeps one failing surface from poisoning the others', async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation((path: string) =>
      path.startsWith('/admin/support/retention') ? refuse('boom') : answer(path),
    );
    open('/support?tab=retention');

    await screen.findByText('Could not work out who is at risk');
    await user.click(screen.getByRole('tab', { name: /Queue/ }));
    expect(await screen.findByRole('button', { name: 'SUP-1051' })).toBeInTheDocument();
  });
});

describe('Support — permission and offline', () => {
  it('tells a role without support.manage that the desk is not theirs, and spends no request saying so', async () => {
    useAdmin.setState({ viewer: { ...owner, role: 'trainer' } as Viewer });
    apiMock.mockImplementation(answer);
    open();

    expect(await screen.findByText('Not available to your role')).toBeInTheDocument();
    expect(pathsCalled()).toHaveLength(0);
  });

  it('says plainly that nothing will reach a member while offline', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    apiMock.mockImplementation(answer);
    open();

    expect(await screen.findByText(/no reply will reach a member/i)).toBeInTheDocument();
    online.mockRestore();
  });
});

/* ============================================================================
   Idempotency — one ticket, one key.

   The server wraps ticket creation in `runIdempotently()`, which replays the
   stored response rather than doing the work twice. That protection is only
   ever as good as the key the client sends, and `idempotencyKey()` ends every
   key with a random suffix — so a key minted inside `mutationFn` was a new key
   on every press.

   The failure that buys: the server writes the ticket, the response is lost on
   the way back, the receptionist sees an error and presses "Raise ticket"
   again. The member now has two threads for one complaint, the queue counts
   the work twice, and the SLA clock starts again on a promise already made.
   ========================================================================= */

/** The `Idempotency-Key` each ticket-create POST carried. */
function createKeys(): string[] {
  return apiMock.mock.calls
    .filter(([path, options]) => path === '/admin/support/tickets' && (options as { method?: string }).method === 'POST')
    .map(([, options]) => (options as { idempotencyKey: string }).idempotencyKey);
}

async function compose(user: ReturnType<typeof userEvent.setup>) {
  open();
  await user.click(await screen.findByRole('button', { name: 'New ticket' }));
  const drawer = await screen.findByRole('dialog');
  await user.type(within(drawer).getByLabelText('Subject'), 'Charged twice in July');
  await user.type(within(drawer).getByLabelText('What happened'), 'Two debits on the 3rd.');
  return drawer;
}

describe('Support — one ticket, one key', () => {
  it('retries a lost ticket under the same key rather than raising two', async () => {
    const user = userEvent.setup();
    const { OfflineError } = await import('../../lib/api');

    apiMock.mockImplementation((path: string, options?: { method?: string }) => {
      if (path === '/admin/support/tickets' && options?.method === 'POST') {
        // The server committed; the response never arrived. From here that is
        // indistinguishable from "nothing happened" — which is exactly why the
        // key has to survive it.
        if (createKeys().length === 1) {
          const rejected = Promise.reject(new OfflineError());
          rejected.catch(() => undefined);
          return rejected;
        }
        return Promise.resolve({ ticket: { id: 'tkt_9' } });
      }
      return answer(path);
    });

    const drawer = await compose(user);
    await user.click(within(drawer).getByRole('button', { name: 'Raise ticket' }));
    await waitFor(() => expect(within(drawer).getByRole('alert')).toBeInTheDocument());

    // The draft is intact, because as far as this screen knows nothing saved.
    await user.click(within(drawer).getByRole('button', { name: 'Raise ticket' }));
    await waitFor(() => expect(createKeys()).toHaveLength(2));

    const keys = createKeys();
    // One complaint, one key: the second request is answered from the first
    // one's record, so one ticket and one SLA promise.
    expect(keys[0]).toBe(keys[1]);
  });

  it('keeps the key across a server refusal so a straight retry cannot double-raise', async () => {
    const user = userEvent.setup();
    const { ApiError } = await import('../../lib/api');

    apiMock.mockImplementation((path: string, options?: { method?: string }) => {
      if (path === '/admin/support/tickets' && options?.method === 'POST') {
        if (createKeys().length === 1) {
          const rejected = Promise.reject(
            new ApiError(500, { error: { code: 'INTERNAL', message: 'That did not save.', requestId: 'req_1' } }),
          );
          rejected.catch(() => undefined);
          return rejected;
        }
        return Promise.resolve({ ticket: { id: 'tkt_9' } });
      }
      return answer(path);
    });

    const drawer = await compose(user);
    await user.click(within(drawer).getByRole('button', { name: 'Raise ticket' }));
    await waitFor(() => expect(within(drawer).getByRole('alert')).toBeInTheDocument());
    await user.click(within(drawer).getByRole('button', { name: 'Raise ticket' }));
    await waitFor(() => expect(createKeys()).toHaveLength(2));

    expect(createKeys()[0]).toBe(createKeys()[1]);
  });

  it('mints a new key when the draft is materially changed', async () => {
    const user = userEvent.setup();
    const { ApiError } = await import('../../lib/api');

    apiMock.mockImplementation((path: string, options?: { method?: string }) => {
      if (path === '/admin/support/tickets' && options?.method === 'POST') {
        const rejected = Promise.reject(
          new ApiError(422, { error: { code: 'VALIDATION_FAILED', message: 'Say more than that.', requestId: 'req_2' } }),
        );
        rejected.catch(() => undefined);
        return rejected;
      }
      return answer(path);
    });

    const drawer = await compose(user);
    await user.click(within(drawer).getByRole('button', { name: 'Raise ticket' }));
    await waitFor(() => expect(createKeys()).toHaveLength(1));

    // A corrected draft is a different request. The server hashes the body
    // alongside the key and refuses a key replayed against different content,
    // so reusing it here would turn a correction into a hard 409.
    await user.type(within(drawer).getByLabelText('What happened'), ' Reference SF-40219.');
    await user.click(within(drawer).getByRole('button', { name: 'Raise ticket' }));
    await waitFor(() => expect(createKeys()).toHaveLength(2));

    expect(createKeys()[0]).not.toBe(createKeys()[1]);
  });
});
