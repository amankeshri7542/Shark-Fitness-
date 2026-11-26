import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChecklistItem, SetupChecklist } from '@shark/contracts';
import { ApiError } from '../../../lib/api';
import { refuse, renderScreen } from '../../../test/harness';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/api')>();
  return { ...actual, api };
});

import Setup from '../Setup';

/* The checklist as the API answers it (packages/domain setupChecklist). */
const item = (overrides: Partial<ChecklistItem>): ChecklistItem => ({
  key: 'branch',
  label: 'Add your first location',
  why: 'Everything else — hours, classes, the door, the till — hangs off a branch.',
  done: true,
  to: '/settings?tab=branches',
  blocking: true,
  ...overrides,
});

const checklist = (overrides: Partial<SetupChecklist> = {}): SetupChecklist => ({
  items: [
    item({}),
    item({ key: 'hours', label: 'Set opening hours', why: 'The door refuses entry outside them.', done: false }),
    item({ key: 'products', label: 'Publish a membership plan', why: 'Nobody can join until there is something to join.', done: false, to: '/plans' }),
    item({ key: 'privacy', label: 'Set data-retention and privacy contact', why: 'A member asking needs somewhere to write to.', done: false, to: '/settings?tab=privacy', blocking: false }),
  ],
  done: 1,
  total: 4,
  readyToOpen: false,
  ...overrides,
});

function show(canManage = true) {
  return renderScreen('/settings?tab=setup', [
    {
      path: '/settings',
      component: () => <Setup canManage={canManage} />,
      validateSearch: (s) => ({ tab: typeof s.tab === 'string' ? s.tab : 'business' }),
    },
    { path: '/plans', component: () => <p>Plans page</p> },
  ]);
}

beforeEach(() => {
  api.mockReset();
});

describe('Setup', () => {
  it('renders nothing and asks nothing of a role without settings access', async () => {
    const { container } = show(false);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(api).not.toHaveBeenCalled();
  });

  it('waits on the checklist without claiming progress or failure', async () => {
    let resolve: (value: SetupChecklist) => void = () => undefined;
    api.mockReturnValue(new Promise((r) => (resolve = r)));
    show();
    await waitFor(() => expect(api).toHaveBeenCalledWith('/admin/settings/setup'));
    expect(screen.queryByText(/of \d+ done/)).not.toBeInTheDocument();
    expect(screen.queryByText('The checklist could not be read')).not.toBeInTheDocument();
    resolve(checklist());
    expect(await screen.findByText('of 4 done')).toBeInTheDocument();
  });

  it('says the checklist could not be read, and reads it again on retry', async () => {
    api.mockImplementationOnce(() =>
      refuse(new ApiError(503, { error: { code: 'INTERNAL', message: 'The settings store is busy.', requestId: 'req_1' } })),
    );
    show();
    expect(await screen.findByText('The checklist could not be read')).toBeInTheDocument();
    expect(screen.getByText('The settings store is busy.')).toBeInTheDocument();

    api.mockResolvedValue(checklist());
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('of 4 done')).toBeInTheDocument();
    expect(screen.queryByText('The checklist could not be read')).not.toBeInTheDocument();
  });

  it('separates what blocks opening from what can wait, and counts what is left', async () => {
    api.mockResolvedValue(checklist());
    show();
    const before = await screen.findByRole('region', { name: 'Before members arrive' });
    const later = screen.getByRole('region', { name: 'When you get to it' });
    expect(within(before).getByText('Set opening hours')).toBeInTheDocument();
    expect(within(later).getByText('Set data-retention and privacy contact')).toBeInTheDocument();
    expect(screen.getByText('2 steps before members arrive')).toBeInTheDocument();

    // A finished step says so instead of offering to do it again.
    const first = within(before).getByText('Add your first location').closest('li')!;
    expect(within(first).getByText('Done')).toBeInTheDocument();
    expect(within(first).queryByRole('link')).not.toBeInTheDocument();
  });

  it('sends each step to the tab that clears it, not to the first tab of Settings', async () => {
    api.mockResolvedValue(checklist());
    const { router } = show();
    const hours = (await screen.findByText('Set opening hours')).closest('li')!;
    const privacy = screen.getByText('Set data-retention and privacy contact').closest('li')!;
    const plans = screen.getByText('Publish a membership plan').closest('li')!;

    // Regression: the link once dropped `?tab=…`, so every settings step
    // opened the Business tab.
    expect(within(hours).getByRole('link', { name: 'Do it' })).toHaveAttribute('href', '/settings?tab=branches');
    expect(within(privacy).getByRole('link', { name: 'Do it' })).toHaveAttribute('href', '/settings?tab=privacy');
    expect(within(plans).getByRole('link', { name: 'Do it' })).toHaveAttribute('href', '/plans');

    await userEvent.click(within(privacy).getByRole('link', { name: 'Do it' }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ tab: 'privacy' }));
  });

  it('drops the outstanding count once nothing blocks opening', async () => {
    api.mockResolvedValue(
      checklist({
        items: [item({}), item({ key: 'rooms', label: 'Name your rooms and studios', done: false, blocking: false })],
        done: 1,
        total: 2,
        readyToOpen: true,
      }),
    );
    show();
    expect(await screen.findByText('of 2 done')).toBeInTheDocument();
    expect(screen.queryByText(/before members arrive$/)).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'When you get to it' })).toBeInTheDocument();
  });

  it('shows an empty checklist as nothing to do rather than failing', async () => {
    api.mockResolvedValue(checklist({ items: [], done: 0, total: 0, readyToOpen: true }));
    show();
    expect(await screen.findByText('of 0 done')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Before members arrive' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
