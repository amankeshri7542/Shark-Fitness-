import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from '@tanstack/react-router';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, api: apiMock };
});

import TasksScreen, { type TaskRow } from '../Tasks';
import { StatusStrip } from '../../ui/shell';
import { refuse, renderScreen, setOnline, signInAs } from '../../test/harness';

const task: TaskRow = {
  id: 'tsk_1',
  branchId: 'br_kor',
  title: 'Payment failed: Aman Mehra',
  detail: 'Reason given: Card declined.',
  source: 'failed_payment',
  sourceLabel: 'Failed payment',
  memberId: 'mbr_1',
  leadId: null,
  link: '/members/mbr_1',
  assignee: { staffId: 'stf_desk', name: 'Priya Rao' },
  priority: 'high',
  status: 'open',
  dueAt: '2026-11-26T10:00:00.000Z',
  dueRelative: '2h',
  overdue: true,
  outcome: null,
  completedAt: null,
};

const screens = [
  {
    path: '/tasks',
    component: TasksScreen,
    validateSearch: (s: Record<string, unknown>) => ({
      view: ['mine', 'open', 'done'].includes(s.view as string) ? (s.view as string) : 'mine',
      ...(typeof s.task === 'string' ? { task: s.task } : {}),
    }),
  },
  { path: '/members/$memberId', component: () => <p>Member page</p> },
];

beforeEach(() => {
  apiMock.mockReset();
  setOnline(true);
  signInAs('branch_manager');
});
afterEach(() => setOnline(true));

describe('Tasks states', () => {
  it('shows a permission state to a role without tasks', async () => {
    signInAs('platform_support');
    renderScreen('/tasks', screens);
    expect(await screen.findByText('Not available to your role')).toBeInTheDocument();
  });

  it('loads, then says nothing is assigned', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    apiMock.mockReturnValue(new Promise((r) => (resolve = r)));
    renderScreen('/tasks', screens);
    expect(await screen.findByLabelText('Loading tasks')).toBeInTheDocument();
    resolve({ items: [], canManage: true });
    expect(await screen.findByText('Nothing assigned to you')).toBeInTheDocument();
  });

  it('says a failed read is not an empty list', async () => {
    apiMock.mockImplementation(() => refuse(new Error('down')));
    renderScreen('/tasks', screens);
    expect(await screen.findByText('Could not load tasks')).toBeInTheDocument();
  });

  it('warns when offline', async () => {
    setOnline(false);
    apiMock.mockResolvedValue({ items: [task], canManage: true });
    renderScreen('/tasks', screens);
    expect(await screen.findByText(/Offline\. What is on screen is the last list/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New task' })).toBeDisabled();
  });

  it('hides the all-open list from a role that only works its own tasks', async () => {
    signInAs('trainer');
    apiMock.mockResolvedValue({ items: [], canManage: false });
    renderScreen('/tasks', screens);
    await screen.findByText('Nothing assigned to you');
    expect(screen.queryByRole('tab', { name: 'All open' })).toBeNull();
  });
});

describe('Working a task', () => {
  it('opens a task, shows why it exists, and finishes it with an outcome', async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation((path: string) => {
      if (path.startsWith('/admin/tasks?')) return Promise.resolve({ items: [task], canManage: true });
      if (path === '/admin/tasks/tsk_1') return Promise.resolve({ task });
      if (path.startsWith('/admin/tasks/assignees')) return Promise.resolve({ items: [{ staffId: 'stf_desk', name: 'Priya Rao' }] });
      if (path === '/admin/tasks/tsk_1/complete') return Promise.resolve({ task: { ...task, status: 'done', outcome: 'Paid at the desk.' } });
      return Promise.resolve({});
    });
    const { router } = renderScreen('/tasks', screens);
    await user.click(await screen.findByRole('button', { name: /Payment failed: Aman Mehra/ }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ task: 'tsk_1' }));

    const drawer = await screen.findByRole('dialog', { name: 'Payment failed: Aman Mehra' });
    expect(within(drawer).getByText('Reason given: Card declined.')).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: 'Open the member' })).toBeInTheDocument();
    const done = within(drawer).getByRole('button', { name: 'Mark done' });
    expect(done).toBeDisabled();
    await user.type(within(drawer).getByLabelText('What happened'), 'Paid at the desk.');
    await user.click(done);
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/admin/tasks/tsk_1/complete', { method: 'POST', body: { outcome: 'Paid at the desk.' } }));
  });

  it('creates a task assigned to someone at the branch', async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation((path: string, options?: { body?: unknown }) => {
      if (path.startsWith('/admin/tasks?')) return Promise.resolve({ items: [], canManage: true });
      if (path.startsWith('/admin/tasks/assignees')) return Promise.resolve({ items: [{ staffId: 'stf_desk', name: 'Priya Rao', role: 'reception' }] });
      if (path === '/admin/tasks') return Promise.resolve({ task: { ...task, id: 'tsk_new' }, echo: options?.body });
      return Promise.resolve({});
    });
    renderScreen('/tasks', screens);
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    const dialog = await screen.findByRole('dialog', { name: 'New task' });
    await user.type(within(dialog).getByLabelText('What needs doing'), 'Restock towels');
    await waitFor(() => expect(within(dialog).getByRole('option', { name: 'Priya Rao' })).toBeInTheDocument());
    await user.selectOptions(within(dialog).getByLabelText('Who'), 'stf_desk');
    await user.selectOptions(within(dialog).getByLabelText('Priority'), 'high');
    await user.click(within(dialog).getByRole('button', { name: 'Create task' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/admin/tasks',
        expect.objectContaining({ method: 'POST', body: expect.objectContaining({ branchId: 'br_kor', title: 'Restock towels', assigneeStaffId: 'stf_desk', priority: 'high' }) }),
      ),
    );
  });
});

describe('Status strip', () => {
  it('shows my tasks and what is waiting to be acted on', async () => {
    signInAs('reception');
    const rootRoute = createRootRoute({
      component: () => <StatusStrip alertCount={2} myTasks={{ open: 3, overdue: 1 }} />,
    });
    const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ['/'] }) });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('link', { name: 'My tasks: 3 open, 1 overdue' })).toHaveTextContent('My tasks 3 · 1 late');
    expect(screen.getByText('2 to act on')).toBeInTheDocument();
  });
});
