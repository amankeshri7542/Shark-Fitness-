import { describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiMock = vi.hoisted(() => vi.fn());

vi.mock('../../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/api')>();
  return { ...actual, api: apiMock };
});

import Transfers from '../Transfers';
import { TZ, allowAll, product, renderPanel, transfer } from './harness';

function callTo(path: string) {
  return apiMock.mock.calls.find(([p]) => p === path) as [string, { body?: unknown }] | undefined;
}

const branches = [
  { id: 'br_kor', name: 'Koramangala' },
  { id: 'br_hsr', name: 'HSR Layout' },
];

function open(overrides: Partial<Parameters<typeof Transfers>[0]> = {}) {
  return renderPanel(
    <Transfers
      transfers={[transfer()]}
      products={[product()]}
      branches={branches}
      loading={false}
      canManage
      online
      timeZone={TZ}
      onRefetch={() => undefined}
      {...overrides}
    />,
  );
}

function detailOf(state: string, overrides: Record<string, unknown> = {}) {
  return {
    transfer: transfer({ state: state as 'draft', ...overrides }),
    lines: [
      {
        id: 'trl_1',
        productId: 'rtl_tee',
        productName: 'Shark Tee — M',
        sku: 'TEE-M',
        quantity: 6,
        quantityReceived: 0,
        shortfall: 0,
        unitCostMinor: 40_000,
      },
    ],
    financial: allowAll,
  };
}

describe('Transfers — the list', () => {
  it('names branches rather than showing raw ids', () => {
    open();
    expect(screen.getByText('Koramangala')).toBeInTheDocument();
    expect(screen.getByText('HSR Layout')).toBeInTheDocument();
    expect(screen.queryByText('br_kor')).not.toBeInTheDocument();
  });

  it('counts what is on the van, not on a shelf', () => {
    open({ transfers: [transfer({ state: 'dispatched', unitsInTransit: 6 })] });
    const row = screen.getByRole('row', { name: /TR-ABC123/ });
    expect(within(row).getByText('In transit')).toBeInTheDocument();
    expect(within(row).getByText('6')).toBeInTheDocument();
    expect(screen.getByText('1 in transit')).toBeInTheDocument();
    // The reference is the row's own control; the row keeps its `row` role.
    expect(within(row).getByRole('button', { name: 'TR-ABC123' })).toBeInTheDocument();
  });
});

describe('Transfers — drafting', () => {
  it('refuses a transfer between one branch and itself', async () => {
    const user = userEvent.setup();
    open({ branches: [branches[0]!, branches[0]!] });

    await user.click(screen.getByRole('button', { name: 'New transfer' }));
    expect(await screen.findByText('A transfer needs two different branches.')).toBeInTheDocument();
  });

  it('will not save a draft with nothing on it', async () => {
    const user = userEvent.setup();
    open();

    await user.click(screen.getByRole('button', { name: 'New transfer' }));
    const drawer = await screen.findByRole('dialog', { name: 'New transfer' });
    expect(within(drawer).getByRole('button', { name: 'Add at least one item' })).toBeDisabled();
  });

  it('creates a draft with the picked quantities', async () => {
    const user = userEvent.setup();
    open();

    await user.click(screen.getByRole('button', { name: 'New transfer' }));
    const drawer = await screen.findByRole('dialog', { name: 'New transfer' });

    await user.click(within(drawer).getByRole('button', { name: 'Add one Shark Tee — M' }));
    await user.click(within(drawer).getByRole('button', { name: 'Add one Shark Tee — M' }));

    apiMock.mockResolvedValue({});
    await user.click(within(drawer).getByRole('button', { name: /Save draft · 2 units/ }));

    await waitFor(() => expect(callTo('/admin/store/transfers')).toBeDefined());
    expect(callTo('/admin/store/transfers')![1].body).toMatchObject({
      fromBranchId: 'br_kor',
      toBranchId: 'br_hsr',
      lines: [{ productId: 'rtl_tee', quantity: 2 }],
    });
  });
});

describe('Transfers — the lifecycle', () => {
  it('dispatches a draft, taking the stock off the source shelf', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(detailOf('draft'));
    open();

    await user.click(screen.getByRole('button', { name: /TR-ABC123/ }));
    apiMock.mockResolvedValue({});
    await user.click(await screen.findByRole('button', { name: 'Dispatch 6 units' }));

    await waitFor(() => expect(callTo('/admin/store/transfers/trf_1/dispatch')).toBeDefined());
  });

  it('defaults the receipt to everything sent, and lets it be counted down', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(detailOf('dispatched'));
    open({ transfers: [transfer({ state: 'dispatched', unitsInTransit: 6 })] });

    await user.click(screen.getByRole('button', { name: /TR-ABC123/ }));

    // The common case is that it all arrived, so that is the default.
    expect(await screen.findByRole('button', { name: 'Receive 6 of 6' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove one Shark Tee — M' }));
    await user.click(screen.getByRole('button', { name: 'Remove one Shark Tee — M' }));
    expect(screen.getByRole('button', { name: 'Receive 4 of 6' })).toBeInTheDocument();
  });

  it('says out loud what a short receipt does to the missing units', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(detailOf('dispatched'));
    open({ transfers: [transfer({ state: 'dispatched', unitsInTransit: 6 })] });

    await user.click(screen.getByRole('button', { name: /TR-ABC123/ }));
    await user.click(await screen.findByRole('button', { name: 'Remove one Shark Tee — M' }));

    // Booking only what arrived would balance the branches and hide the loss.
    expect(screen.getByText(/1 unit short/)).toBeInTheDocument();
    expect(screen.getByText(/books it as damage at HSR Layout/)).toBeInTheDocument();
    expect(screen.getByText(/will show in shrinkage/)).toBeInTheDocument();
  });

  it('posts the per-line counts on receipt', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(detailOf('dispatched'));
    open({ transfers: [transfer({ state: 'dispatched', unitsInTransit: 6 })] });

    await user.click(screen.getByRole('button', { name: /TR-ABC123/ }));
    await user.click(await screen.findByRole('button', { name: 'Remove one Shark Tee — M' }));
    apiMock.mockResolvedValue({});
    await user.click(screen.getByRole('button', { name: 'Receive 5 of 6' }));

    await waitFor(() => expect(callTo('/admin/store/transfers/trf_1/receive')).toBeDefined());
    expect(callTo('/admin/store/transfers/trf_1/receive')![1].body).toEqual({
      lines: [{ lineId: 'trl_1', quantity: 5 }],
    });
  });

  it('shows the shortfall against a received transfer', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue({
      ...detailOf('received', { receivedBy: 'Sunita Rao', receivedAt: '2026-08-18T12:00:00.000Z' }),
      lines: [
        {
          id: 'trl_1',
          productId: 'rtl_tee',
          productName: 'Shark Tee — M',
          sku: 'TEE-M',
          quantity: 6,
          quantityReceived: 5,
          shortfall: 1,
          unitCostMinor: 40_000,
        },
      ],
    });
    open({ transfers: [transfer({ state: 'received' })] });

    // A received transfer is closed, so it only shows under the "All" filter.
    await user.click(screen.getByRole('button', { name: 'All' }));
    await user.click(screen.getByRole('button', { name: /TR-ABC123/ }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('Short')).toBeInTheDocument();
    // Neither dispatch nor receive is offered on a closed transfer.
    expect(within(drawer).queryByRole('button', { name: /Dispatch/ })).not.toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: /^Receive/ })).not.toBeInTheDocument();
  });

  it('confirms a draft cancellation with its consequence and a reason', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(detailOf('draft'));
    open();

    await user.click(screen.getByRole('button', { name: /TR-ABC123/ }));
    await user.click(await screen.findByRole('button', { name: 'Cancel draft' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/Nothing has left the shelf yet/)).toBeInTheDocument();

    const confirm = within(dialog).getByRole('button', { name: 'Cancel the draft' });
    expect(confirm).toBeDisabled();

    await user.type(within(dialog).getByLabelText('Reason'), 'Ordered by mistake');
    apiMock.mockResolvedValue({});
    await user.click(confirm);

    await waitFor(() => expect(callTo('/admin/store/transfers/trf_1/cancel')).toBeDefined());
    expect(callTo('/admin/store/transfers/trf_1/cancel')![1].body).toEqual({ reason: 'Ordered by mistake' });
  });

  it('gives a read-only role no lifecycle actions at all', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(detailOf('draft'));
    open({ canManage: false });

    expect(screen.queryByRole('button', { name: 'New transfer' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /TR-ABC123/ }));
    await screen.findByRole('dialog');
    expect(screen.queryByRole('button', { name: /Dispatch/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel draft' })).not.toBeInTheDocument();
  });
});

describe('Transfers — states other than a list of rows', () => {
  it('says a transfer could not be read instead of pretending to still be loading', async () => {
    const user = userEvent.setup();
    open();
    apiMock.mockImplementation(() => {
      const rejected = Promise.reject(new Error('boom'));
      rejected.catch(() => undefined);
      return rejected;
    });

    await user.click(screen.getByRole('button', { name: /TR-ABC123/ }));

    expect(await screen.findByText('Could not load this transfer')).toBeInTheDocument();
    expect(screen.getByText(/No stock has been dispatched, received or cancelled/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Dispatch/ })).not.toBeInTheDocument();
  });

  it('offers no stock movement at all while offline', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(detailOf('dispatched'));
    open({ online: false });

    expect(screen.getByRole('button', { name: 'Offline' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /TR-ABC123/ }));
    await screen.findByText(/Dispatch, receipt and cancellation all need a connection/);
    expect(screen.queryByRole('button', { name: /^Receive/ })).not.toBeInTheDocument();
  });

  it('dates a transfer by the branch clock', () => {
    const late = transfer({ createdAt: '2026-08-18T20:30:00.000Z' });
    open({ transfers: [late], timeZone: 'Asia/Kolkata' });
    expect(screen.getByText(/19 Aug/)).toBeInTheDocument();

    cleanup();
    open({ transfers: [late], timeZone: 'Europe/London' });
    expect(screen.getByText(/18 Aug/)).toBeInTheDocument();
  });
});
