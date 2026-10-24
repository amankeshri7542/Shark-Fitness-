import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiMock = vi.hoisted(() => vi.fn());
const downloadMock = vi.hoisted(() => vi.fn());
const saveBlobMock = vi.hoisted(() => vi.fn());
const permissionMock = vi.hoisted(() => vi.fn());

// The directory keeps its filters in the URL, so the router mock holds a
// search object and re-renders its readers when a filter navigates.
const router = vi.hoisted(() => ({ search: {} as Record<string, unknown>, listeners: new Set<() => void>() }));

vi.mock('@tanstack/react-router', async () => {
  const React = await import('react');
  return {
    Link: ({ children }: { children: ReactNode }) => <a href="/admin/members">{children}</a>,
    useSearch: () => {
      const [, rerender] = React.useReducer((n: number) => n + 1, 0);
      React.useEffect(() => {
        router.listeners.add(rerender);
        return () => {
          router.listeners.delete(rerender);
        };
      }, []);
      return router.search;
    },
    useNavigate: () => (options: { search: (current: Record<string, unknown>) => Record<string, unknown> }) => {
      router.search = options.search(router.search);
      for (const listener of router.listeners) listener();
    },
  };
});

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, api: apiMock, apiDownload: downloadMock, saveBlob: saveBlobMock };
});

vi.mock('../../lib/store', () => ({
  useAdmin: (select: (s: { activeBranchId: string | null }) => unknown) => select({ activeBranchId: 'br_kor' }),
  usePermission: (permission: string) => permissionMock(permission) as boolean,
}));

import MembersScreen from '../Members';

function row(id: string, name: string, tags: string[] = []) {
  return {
    id,
    memberNo: `SF-${id}`,
    name,
    initials: name.slice(0, 2).toUpperCase(),
    email: null,
    phone: null,
    lifecycle: 'active',
    branchName: 'Koramangala',
    trainerName: null,
    joinedOn: '2026-01-01',
    lastVisitLabel: 'Today',
    daysSinceVisit: 0,
    membershipState: 'active',
    productName: 'Monthly',
    endsOn: null,
    autoRenew: true,
    balanceMinor: 0,
    balanceLabel: null,
    riskScore: 10,
    riskBand: 'low',
    riskReasons: [],
    tags,
  };
}

const DIRECTORY = {
  total: 2,
  offset: 0,
  limit: 50,
  scopeNote: 'Showing Koramangala.',
  columns: { balanceVisible: true },
  items: [row('m1', 'Asha Iyer', ['vip']), row('m2', 'Ravi Shah')],
};

function routeApi(handlers: Record<string, (options?: { body?: unknown }) => unknown>) {
  apiMock.mockImplementation((path: string, options?: { body?: unknown }) => {
    const key = Object.keys(handlers).find((k) => path.startsWith(k));
    if (!key) return Promise.reject(new Error(`unexpected ${path}`));
    return Promise.resolve(handlers[key]!(options));
  });
}

function renderScreen() {
  const client = new QueryClient({
    mutationCache: new MutationCache({ onError: () => undefined }),
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MembersScreen />
    </QueryClientProvider>,
  );
}

describe('members bulk actions', () => {
  beforeEach(() => {
    apiMock.mockReset();
    downloadMock.mockReset();
    saveBlobMock.mockReset();
    permissionMock.mockReset();
    permissionMock.mockReturnValue(true);
    router.search = {};
  });

  it('shows the bulk bar only after a selection, and select-all picks every shown row', async () => {
    routeApi({ '/admin/members?': () => DIRECTORY });
    const user = userEvent.setup();
    renderScreen();

    await screen.findByText('Asha Iyer');
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();

    await user.click(screen.getByLabelText('Select all shown'));
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Clear selection'));
    expect(screen.queryByText('2 selected')).not.toBeInTheDocument();
  });

  it('adds a tag to the selected members', async () => {
    let tagBody: unknown;
    routeApi({
      '/admin/members/bulk/tag': (options) => {
        tagBody = options?.body;
        return { message: 'Tagged 1 member “pt-client”.' };
      },
      '/admin/members?': () => DIRECTORY,
    });
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByLabelText('Select Ravi Shah'));
    await user.click(screen.getByRole('button', { name: 'Add tag' }));

    const drawer = screen.getByRole('dialog', { name: 'Add tag' });
    await user.type(within(drawer).getByLabelText('Tag'), 'pt-client');
    await user.click(within(drawer).getByRole('button', { name: 'Add tag' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Tagged 1 member');
    expect(tagBody).toEqual({ memberIds: ['m2'], tag: 'pt-client', mode: 'add' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('offers tags already on the selection as one-click choices', async () => {
    routeApi({ '/admin/members?': () => DIRECTORY });
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByLabelText('Select Asha Iyer'));
    await user.click(screen.getByRole('button', { name: 'Add tag' }));
    const drawer = screen.getByRole('dialog', { name: 'Add tag' });
    await user.click(within(drawer).getByRole('button', { name: 'vip' }));
    expect(within(drawer).getByLabelText('Tag')).toHaveValue('vip');
  });

  it('assigns a trainer in one click from the list', async () => {
    let trainerBody: unknown;
    routeApi({
      '/admin/members/trainers': () => ({ items: [{ id: 'stf_1', name: 'Rehan Ahmed', memberCount: 12 }] }),
      '/admin/members/bulk/trainer': (options) => {
        trainerBody = options?.body;
        return { message: 'Assigned 2 members to Rehan Ahmed.' };
      },
      '/admin/members?': () => DIRECTORY,
    });
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByLabelText('Select all shown'));
    await user.click(screen.getByRole('button', { name: 'Assign trainer' }));
    await user.click(await screen.findByRole('button', { name: /Rehan Ahmed/ }));

    expect(await screen.findByRole('status')).toHaveTextContent('Assigned 2 members to Rehan Ahmed.');
    expect(trainerBody).toEqual({ memberIds: ['m1', 'm2'], trainerId: 'stf_1' });
  });

  it('sends a message to the selection', async () => {
    let messageBody: unknown;
    routeApi({
      '/admin/members/bulk/message': (options) => {
        messageBody = options?.body;
        return { message: 'Sent to 1 member in the app.' };
      },
      '/admin/members?': () => DIRECTORY,
    });
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByLabelText('Select Asha Iyer'));
    await user.click(screen.getByRole('button', { name: 'Message' }));
    const drawer = screen.getByRole('dialog', { name: 'Message members' });
    const send = within(drawer).getByRole('button', { name: 'Send to 1' });
    expect(send).toBeDisabled();

    await user.type(within(drawer).getByRole('textbox'), 'Pool closed Sunday.');
    await user.click(send);

    expect(await screen.findByRole('status')).toHaveTextContent('Sent to 1 member in the app.');
    expect(messageBody).toEqual({ memberIds: ['m1'], body: 'Pool closed Sunday.' });
  });

  it('exports the selection as a CSV download', async () => {
    routeApi({ '/admin/members?': () => DIRECTORY });
    const blob = new Blob(['csv'], { type: 'text/csv' });
    downloadMock.mockResolvedValue({ blob, filename: 'members-2026-10-22.csv' });
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByLabelText('Select all shown'));
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));

    await waitFor(() => expect(saveBlobMock).toHaveBeenCalledWith(blob, 'members-2026-10-22.csv'));
    expect(downloadMock).toHaveBeenCalledWith('/admin/members/bulk/export', {
      body: { memberIds: ['m1', 'm2'] },
      branchId: 'br_kor',
    });
    expect(screen.getByRole('status')).toHaveTextContent('Exported 2 members to CSV.');
  });

  it('shows the server’s refusal instead of closing the drawer', async () => {
    routeApi({
      '/admin/members/bulk/tag': () => Promise.reject(new Error('One of the selected members could not be found.')),
      '/admin/members?': () => DIRECTORY,
    });
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByLabelText('Select Ravi Shah'));
    await user.click(screen.getByRole('button', { name: 'Add tag' }));
    const drawer = screen.getByRole('dialog', { name: 'Add tag' });
    await user.type(within(drawer).getByLabelText('Tag'), 'vip');
    await user.click(within(drawer).getByRole('button', { name: 'Add tag' }));

    expect(await within(drawer).findByText('One of the selected members could not be found.')).toBeInTheDocument();
  });

  it('shows tags on the row and filters by one in a click', async () => {
    routeApi({ '/admin/members?': () => DIRECTORY });
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByRole('button', { name: 'vip' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith(expect.stringContaining('tag=vip'), expect.anything()));
    await user.click(screen.getByLabelText('Clear tag filter vip'));
    expect(screen.queryByLabelText('Clear tag filter vip')).not.toBeInTheDocument();
  });

  it('hides actions the role cannot use', async () => {
    permissionMock.mockImplementation((p: string) => p === 'member.view');
    routeApi({ '/admin/members?': () => DIRECTORY });
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByLabelText('Select Asha Iyer'));
    expect(screen.queryByRole('button', { name: 'Add tag' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Export CSV' })).not.toBeInTheDocument();
  });
});
