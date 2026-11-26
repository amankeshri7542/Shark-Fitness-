import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BranchDetail } from '@shark/contracts';
import { ApiError } from '../../../lib/api';
import { refuse } from '../../../test/harness';
import { branch, renderPanel } from './harness';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/api')>();
  return { ...actual, api };
});

import Branches from '../Branches';

const indiranagar = branch({
  id: 'br_ind',
  name: 'Indiranagar Reef',
  slug: 'indiranagar',
  addressLine: '12th Main, HAL 2nd Stage',
  state: 'draft',
  stateMeaning: 'Being set up. Not open to members and not counted in operations.',
  trades: false,
  nextStates: ['active', 'archived'],
  rooms: [],
  counts: { members: 0, grantedMembers: 0, futureBookings: 0, staff: 1, openTickets: 0 },
});
const whitefield = branch({
  id: 'br_wf',
  name: 'Whitefield Shoal',
  slug: 'whitefield',
  state: 'archived',
  stateMeaning: 'Permanently closed. Its history stays readable; nothing new is accepted.',
  trades: false,
  nextStates: [],
});

function respond(items: BranchDetail[]) {
  api.mockImplementation((path: string, options?: { method?: string }) => {
    if (path === '/admin/settings/branches' && !options?.method) return Promise.resolve({ items });
    if (path.startsWith('/admin/settings/timezones')) return Promise.resolve({ items: ['Asia/Dubai', 'Asia/Kolkata'] });
    if (path === '/admin/settings/branches' && options?.method === 'POST') {
      return Promise.resolve({ branch: branch({ id: 'br_new', name: 'HSR Lagoon', state: 'draft' }) });
    }
    return Promise.reject(new Error(`unexpected ${path}`));
  });
}

beforeEach(() => {
  api.mockReset();
});

describe('Branches', () => {
  it('renders nothing and reads nothing for a role without settings access', () => {
    const { container } = renderPanel(<Branches canManage={false} />);
    expect(container).toBeEmptyDOMElement();
    expect(api).not.toHaveBeenCalled();
  });

  it('shows neither an empty estate nor an error while the list loads', async () => {
    let resolve: (value: { items: BranchDetail[] }) => void = () => undefined;
    api.mockReturnValue(new Promise((r) => (resolve = r)));
    renderPanel(<Branches canManage />);
    await waitFor(() => expect(api).toHaveBeenCalledWith('/admin/settings/branches'));
    expect(screen.queryByText('No locations yet')).not.toBeInTheDocument();
    expect(screen.queryByText('Your branches could not be read')).not.toBeInTheDocument();
    resolve({ items: [branch()] });
    expect(await screen.findByRole('navigation', { name: 'Locations' })).toBeInTheDocument();
  });

  it('says the branches could not be read, and recovers on retry', async () => {
    api.mockImplementationOnce(() =>
      refuse(new ApiError(500, { error: { code: 'INTERNAL', message: 'Branch store unavailable.', requestId: 'req_b' } })),
    );
    renderPanel(<Branches canManage />);
    expect(await screen.findByText('Your branches could not be read')).toBeInTheDocument();
    expect(screen.getByText('Branch store unavailable.')).toBeInTheDocument();

    respond([branch()]);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('navigation', { name: 'Locations' })).toBeInTheDocument();
  });

  it('offers to add the first location when there are none', async () => {
    respond([]);
    renderPanel(<Branches canManage />);
    expect(await screen.findByText('No locations yet')).toBeInTheDocument();
    expect(screen.getByText('0 shown')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Add a location' })).toHaveLength(2);
  });

  it('lists the estate, opens the first branch, and switches to another', async () => {
    respond([branch(), indiranagar]);
    renderPanel(<Branches canManage />);
    const nav = await screen.findByRole('navigation', { name: 'Locations' });
    const kor = within(nav).getByRole('button', { name: /Koramangala Depot/ });
    expect(kor).toHaveAttribute('aria-current', 'true');
    expect(within(kor).getByText('Bengaluru · 23 members')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Koramangala Depot' })).toBeInTheDocument();

    await userEvent.click(within(nav).getByRole('button', { name: /Indiranagar Reef/ }));
    expect(screen.getByRole('heading', { name: 'Indiranagar Reef' })).toBeInTheDocument();
    expect(screen.getByText('Being set up. Not open to members and not counted in operations.')).toBeInTheDocument();
  });

  it('hides archived locations until asked', async () => {
    respond([branch(), whitefield]);
    renderPanel(<Branches canManage />);
    const nav = await screen.findByRole('navigation', { name: 'Locations' });
    expect(within(nav).queryByText('Whitefield Shoal')).not.toBeInTheDocument();
    expect(screen.getByText('1 shown')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Show 1 archived' }));
    expect(within(nav).getByText('Whitefield Shoal')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide archived' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('creates a new location as a draft', async () => {
    respond([branch()]);
    renderPanel(<Branches canManage />);
    await screen.findByRole('navigation', { name: 'Locations' });
    await userEvent.click(screen.getByRole('button', { name: 'Add a location' }));

    const dialog = await screen.findByRole('dialog', { name: 'Add a location' });
    const create = within(dialog).getByRole('button', { name: 'Create as draft' });
    expect(create).toBeDisabled();

    await userEvent.type(within(dialog).getByLabelText('Name'), 'HSR Lagoon');
    // The short name follows the name until somebody types their own.
    expect(within(dialog).getByLabelText('Short name')).toHaveValue('h');
    await userEvent.clear(within(dialog).getByLabelText('Short name'));
    await userEvent.type(within(dialog).getByLabelText('Short name'), 'hsr');
    await userEvent.type(within(dialog).getByLabelText('Address'), '27th Main, Sector 1');
    await userEvent.type(within(dialog).getByLabelText('City'), 'Bengaluru');
    await within(dialog).findByRole('option', { name: 'Asia/Kolkata' });
    await userEvent.selectOptions(within(dialog).getByLabelText('Timezone'), 'Asia/Kolkata');
    expect(create).toBeEnabled();

    await userEvent.click(create);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        '/admin/settings/branches',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({ name: 'HSR Lagoon', slug: 'hsr', city: 'Bengaluru', timezone: 'Asia/Kolkata', capacity: 60 }),
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add a location' })).not.toBeInTheDocument());
  });

  it('keeps the dialog open and says why when a location cannot be created', async () => {
    respond([branch()]);
    const base = api.getMockImplementation()!;
    api.mockImplementation((path: string, options?: { method?: string }) =>
      path === '/admin/settings/branches' && options?.method === 'POST'
        ? refuse(new ApiError(409, { error: { code: 'CONFLICT', message: 'Another location already uses that short name.', requestId: 'r' } }))
        : base(path, options),
    );
    renderPanel(<Branches canManage />);
    await screen.findByRole('navigation', { name: 'Locations' });
    await userEvent.click(screen.getByRole('button', { name: 'Add a location' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a location' });
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Koramangala');
    await userEvent.type(within(dialog).getByLabelText('Address'), 'Somewhere');
    await userEvent.type(within(dialog).getByLabelText('City'), 'Bengaluru');
    await within(dialog).findByRole('option', { name: 'Asia/Kolkata' });
    await userEvent.selectOptions(within(dialog).getByLabelText('Timezone'), 'Asia/Kolkata');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create as draft' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Another location already uses that short name.');
  });
});
