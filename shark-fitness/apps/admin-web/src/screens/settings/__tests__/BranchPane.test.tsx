import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Consequence } from '@shark/contracts';
import { ApiError } from '../../../lib/api';
import { refuse } from '../../../test/harness';
import { branch, renderPanel } from './harness';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/api')>();
  return { ...actual, api };
});

import BranchPane from '../BranchPane';

const conflict = (message: string, consequences: Consequence[]) =>
  new ApiError(409, { error: { code: 'CONFLICT', message, requestId: 'req_c', details: { consequences } } });

beforeEach(() => {
  api.mockReset();
  api.mockResolvedValue({ branch: branch() });
});

describe('BranchPane', () => {
  it('states what the location is, what it holds, and the clock it runs on', () => {
    renderPanel(<BranchPane branch={branch()} />);
    const state = screen.getByRole('region', { name: 'Location state' });
    expect(within(state).getByRole('heading', { name: 'Koramangala Depot' })).toBeInTheDocument();
    expect(within(state).getByText('Open and trading.')).toBeInTheDocument();
    expect(within(state).getByText('Booked ahead').nextElementSibling).toHaveTextContent('1532');
    expect(screen.getByLabelText('Address')).toHaveValue('80 Feet Road, 5th Block');
    expect(screen.getByText('Asia/Kolkata')).toBeInTheDocument();
    expect(screen.getByText('Studio 1')).toBeInTheDocument();
    expect(screen.getByText('No holidays set. This location trades on its normal hours all year.')).toBeInTheDocument();
    // Every day falls back to the typical hours until it has its own.
    expect(screen.getByLabelText('Monday opens')).toHaveValue('05:00');
    expect(screen.getAllByText('typical')).toHaveLength(7);
    expect(screen.getByText('Everything inherited from gym settings')).toBeInTheDocument();
  });

  it('offers no state change for a location with nowhere to go', () => {
    renderPanel(<BranchPane branch={branch({ state: 'archived', trades: false, nextStates: [] })} />);
    expect(screen.queryByLabelText('Change state to')).not.toBeInTheDocument();
  });

  it('asks why before changing state, and records the reason with the change', async () => {
    renderPanel(<BranchPane branch={branch()} />);
    expect(screen.queryByLabelText('Why')).not.toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Change state to'), 'temporarily_closed');
    const close = screen.getByRole('button', { name: 'Close temporarily' });
    expect(close).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Why'), 'Chiller failure');
    expect(close).toBeEnabled();
    await userEvent.click(close);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/admin/settings/branches/br_kor/state', {
        method: 'POST',
        body: { state: 'temporarily_closed', note: 'Chiller failure' },
      }),
    );
  });

  it('shows what a change does to existing records and sends the acknowledgement back', async () => {
    api.mockImplementationOnce(() =>
      refuse(
        conflict('This change affects records that already exist.', [
          { code: 'FUTURE_BOOKINGS', message: '1,532 booked seats stay booked at a closed location.', blocking: false, count: 1532 },
        ]),
      ),
    );
    renderPanel(<BranchPane branch={branch()} />);
    await userEvent.selectOptions(screen.getByLabelText('Change state to'), 'temporarily_closed');
    await userEvent.type(screen.getByLabelText('Why'), 'Refit for six weeks');
    await userEvent.click(screen.getByRole('button', { name: 'Close temporarily' }));

    const dialog = await screen.findByRole('dialog', { name: 'This affects records that already exist' });
    expect(within(dialog).getByText('1,532 booked seats stay booked at a closed location.')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply anyway' }));
    await waitFor(() =>
      expect(api).toHaveBeenLastCalledWith('/admin/settings/branches/br_kor/state', {
        method: 'POST',
        body: { state: 'temporarily_closed', note: 'Refit for six weeks', acknowledge: ['FUTURE_BOOKINGS'] },
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('cannot confirm a change the server says is blocked', async () => {
    api.mockImplementationOnce(() =>
      refuse(
        conflict('Move the staff first.', [{ code: 'STAFF_ASSIGNED', message: 'Seven staff are still assigned here.', blocking: true }]),
      ),
    );
    renderPanel(<BranchPane branch={branch()} />);
    await userEvent.selectOptions(screen.getByLabelText('Change state to'), 'archived');
    await userEvent.type(screen.getByLabelText('Why'), 'Lease not renewed');
    await userEvent.click(screen.getByRole('button', { name: 'Archive permanently' }));

    const dialog = await screen.findByRole('dialog', { name: 'This affects records that already exist' });
    expect(within(dialog).getByText('Cannot continue yet')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Apply anyway' })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('saves the address and says why a save was refused', async () => {
    api.mockImplementationOnce(() =>
      refuse(new ApiError(422, { error: { code: 'VALIDATION_FAILED', message: 'Capacity must be at least 1.', requestId: 'r' } })),
    );
    renderPanel(<BranchPane branch={branch()} />);
    const section = screen.getByRole('region', { name: 'Address and contact' });
    const save = within(section).getByRole('button', { name: 'Save address and contact' });
    expect(save).toBeDisabled();

    fireEvent.change(within(section).getByLabelText('Capacity'), { target: { value: '0' } });
    await userEvent.click(save);
    expect(await within(section).findByRole('alert')).toHaveTextContent('Capacity must be at least 1.');
    expect(api).toHaveBeenCalledWith('/admin/settings/branches/br_kor', {
      method: 'PATCH',
      body: expect.objectContaining({ capacity: 0, name: 'Koramangala Depot' }),
    });
  });

  it('saves a day of its own hours', async () => {
    renderPanel(<BranchPane branch={branch()} />);
    await userEvent.click(screen.getByLabelText('Sunday closed all day'));
    expect(screen.getByLabelText('Sunday opens')).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Save opening hours' }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/admin/settings/branches/br_kor', {
        method: 'PATCH',
        body: { hours: { sun: { open: 300, close: 1380, closed: true } } },
      }),
    );
  });

  it('adds a room and says when one cannot be removed', async () => {
    api.mockImplementation((path: string, options?: { method?: string }) =>
      options?.method === 'DELETE'
        ? refuse(new ApiError(409, { error: { code: 'CONFLICT', message: 'Studio 1 has classes scheduled.', requestId: 'r' } }))
        : Promise.resolve({ room: { id: 'rom_2' } }),
    );
    renderPanel(<BranchPane branch={branch()} />);
    const rooms = screen.getByRole('region', { name: 'Rooms and areas' });

    await userEvent.type(within(rooms).getByLabelText('Room name'), 'Studio 2');
    await userEvent.click(within(rooms).getByRole('button', { name: 'Add room' }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/admin/settings/branches/br_kor/rooms', { method: 'POST', body: { name: 'Studio 2', capacity: 12 } }),
    );

    await userEvent.click(within(rooms).getByRole('button', { name: 'Remove' }));
    expect(await within(rooms).findByRole('alert')).toHaveTextContent('Studio 1 has classes scheduled.');
  });

  it('marks an override and saves only what differs from the gym', async () => {
    renderPanel(<BranchPane branch={branch()} />);
    fireEvent.change(screen.getByLabelText('Anti-passback window'), { target: { value: '120' } });
    expect(screen.getByText('1 setting differs here')).toBeInTheDocument();
    expect(screen.getByText('Overridden here')).toBeInTheDocument();
    expect(screen.getByText('Gym default: 90')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Save overrides' }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/admin/settings/branches/br_kor', { method: 'PATCH', body: { policy: { antiPassbackSeconds: 120 } } }),
    );
  });
});
