import { describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiMock = vi.hoisted(() => vi.fn());

vi.mock('../../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/api')>();
  return { ...actual, api: apiMock };
});

import Orders from '../Orders';
import { TZ, allowAll, noFinancials, order, renderPanel } from './harness';

function callTo(path: string) {
  return apiMock.mock.calls.find(([p]) => p === path) as [string, { body?: unknown }] | undefined;
}

function open(overrides: Partial<Parameters<typeof Orders>[0]> = {}) {
  return renderPanel(
    <Orders
      orders={[order()]}
      loading={false}
      canManage
      online
      timeZone={TZ}
      onRefetch={() => undefined}
      {...overrides}
    />,
  );
}

/** Two units sold, none returned yet. */
const detail = {
  order: order(),
  lines: [
    {
      id: 'pol_1',
      productId: 'rtl_tee',
      name: 'Shark Tee — M',
      quantity: 2,
      unitMinor: 50_000,
      discountMinor: 0,
      taxRateBp: 1800,
      taxMinor: 18_000,
      totalMinor: 118_000,
      quantityReturned: 0,
      quantityReturnable: 2,
      unitCostMinor: 20_000,
    },
  ],
  tenders: [{ id: 'pay_1', method: 'cash', amountMinor: 118_000, reference: '', at: '2026-08-18T09:30:00.000Z' }],
  returnedFrom: null,
  financial: allowAll,
};

describe('Orders — history', () => {
  it('separates a refund from a sale rather than showing one negative row', async () => {
    open({
      orders: [
        order(),
        order({ id: 'pos_2', reference: 'SF-…-R', kind: 'return', totalMinor: -59_000 }),
      ],
    });

    expect(screen.getByText('Sold')).toBeInTheDocument();
    expect(screen.getByText('Refund')).toBeInTheDocument();
  });

  it('marks a sale that was charged to an account', () => {
    open({ orders: [order({ invoiceId: 'inv_1', memberName: 'Asha Iyer' })] });
    expect(screen.getByText('Invoiced')).toBeInTheDocument();
    expect(screen.getByText('Asha Iyer')).toBeInTheDocument();
  });

  it('filters to voided sales', async () => {
    const user = userEvent.setup();
    open({ orders: [order(), order({ id: 'pos_3', reference: 'SF-V', state: 'voided' })] });

    await user.click(screen.getByRole('button', { name: 'Voided' }));
    // The voided receipt is the only row left; the filter chip shares its word.
    expect(screen.getByRole('button', { name: /SF-V/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /SF-20260818-AB12C/ })).not.toBeInTheDocument();
  });
});

describe('Orders — returns', () => {
  it('prices a partial return the way the server does', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(detail);
    open();

    await user.click(screen.getByRole('button', { name: /SF-20260818-AB12C/ }));
    await user.click(await screen.findByRole('button', { name: 'Return items' }));

    // One of two units: half the discount and half the tax come back too.
    await user.click(screen.getByRole('button', { name: 'Add one Shark Tee — M' }));
    expect(screen.getByRole('button', { name: /Refund ₹590.00/ })).toBeInTheDocument();
  });

  it('will not refund without a reason', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(detail);
    open();

    await user.click(screen.getByRole('button', { name: /SF-20260818-AB12C/ }));
    await user.click(await screen.findByRole('button', { name: 'Return items' }));
    await user.click(screen.getByRole('button', { name: 'Add one Shark Tee — M' }));

    expect(screen.getByRole('button', { name: /^Refund ₹/ })).toBeDisabled();

    await user.type(screen.getByLabelText('Reason for the refund'), 'Wrong size');
    expect(screen.getByRole('button', { name: /^Refund ₹/ })).toBeEnabled();
  });

  it('says the original sale is not edited', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(detail);
    open();

    await user.click(screen.getByRole('button', { name: /SF-20260818-AB12C/ }));
    await user.click(await screen.findByRole('button', { name: 'Return items' }));
    await user.click(screen.getByRole('button', { name: 'Add one Shark Tee — M' }));

    expect(screen.getByText(/writes a separate refund against it/)).toBeInTheDocument();
  });

  it('posts only the picked lines', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(detail);
    open();

    await user.click(screen.getByRole('button', { name: /SF-20260818-AB12C/ }));
    await user.click(await screen.findByRole('button', { name: 'Return items' }));
    await user.click(screen.getByRole('button', { name: 'Add one Shark Tee — M' }));
    await user.type(screen.getByLabelText('Reason for the refund'), 'Wrong size');
    await user.click(screen.getByRole('button', { name: /Refund ₹590.00/ }));

    await waitFor(() => expect(callTo('/admin/store/orders/pos_1/refund')).toBeDefined());
    expect(callTo('/admin/store/orders/pos_1/refund')![1].body).toMatchObject({
      reason: 'Wrong size',
      lines: [{ lineId: 'pol_1', quantity: 1 }],
    });
  });

  it('offers nothing to return once everything is back', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue({
      ...detail,
      order: order({ state: 'returned' }),
      lines: [{ ...detail.lines[0]!, quantityReturned: 2, quantityReturnable: 0 }],
    });
    open();

    await user.click(screen.getByRole('button', { name: /SF-20260818-AB12C/ }));
    expect(await screen.findByRole('button', { name: 'Fully returned' })).toBeDisabled();
  });
});

describe('Orders — voiding', () => {
  it('states the consequence and demands a reason before voiding', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(detail);
    open();

    await user.click(screen.getByRole('button', { name: /SF-20260818-AB12C/ }));
    await user.click(await screen.findByRole('button', { name: 'Void sale' }));

    const dialog = await screen.findByRole('alertdialog');
    // Impact and scope, per the Design PRD, not a bare "are you sure?".
    expect(within(dialog).getByText(/comes out of today's takings/)).toBeInTheDocument();
    expect(within(dialog).getByText(/cannot be undone/)).toBeInTheDocument();

    const confirm = within(dialog).getByRole('button', { name: 'Void the sale' });
    expect(confirm).toBeDisabled();

    await user.type(within(dialog).getByLabelText('Reason'), 'Rung up twice');
    expect(confirm).toBeEnabled();
  });

  it('waits for the server before claiming the sale is void', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(detail);
    open();

    await user.click(screen.getByRole('button', { name: /SF-20260818-AB12C/ }));
    await user.click(await screen.findByRole('button', { name: 'Void sale' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByLabelText('Reason'), 'Rung up twice');

    let release: (value: unknown) => void = () => undefined;
    apiMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    await user.click(within(dialog).getByRole('button', { name: 'Void the sale' }));

    // Still open and still pending — nothing is claimed until the server answers.
    expect(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Working…' })).toBeDisabled();

    apiMock.mockResolvedValue({ ...detail, order: order({ state: 'voided', voidReason: 'Rung up twice' }) });
    release({ ...detail, order: order({ state: 'voided' }) });

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(callTo('/admin/store/orders/pos_1/void')![1].body).toEqual({ reason: 'Rung up twice' });
  });

  it('lets nobody void or refund while offline', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(detail);
    open({ online: false });

    await user.click(screen.getByRole('button', { name: /SF-20260818-AB12C/ }));
    await screen.findByText(/Refunds and voids need a connection/);
    expect(screen.queryByRole('button', { name: 'Void sale' })).not.toBeInTheDocument();
  });

  it('offers neither action to a role that may only look', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(detail);
    open({ canManage: false });

    await user.click(screen.getByRole('button', { name: /SF-20260818-AB12C/ }));
    await screen.findByRole('dialog');
    expect(screen.queryByRole('button', { name: 'Void sale' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Return items' })).not.toBeInTheDocument();
  });
});

describe('Orders — a receipt that could not be read', () => {
  it('says the read failed instead of sitting on the skeleton for ever', async () => {
    const user = userEvent.setup();
    open();
    apiMock.mockImplementation(() => {
      const rejected = Promise.reject(new Error('boom'));
      rejected.catch(() => undefined);
      return rejected;
    });

    await user.click(screen.getByRole('button', { name: /SF-20260818-AB12C/ }));

    expect(await screen.findByText('Could not load this receipt')).toBeInTheDocument();
    expect(screen.getByText(/Nothing has been refunded or voided/)).toBeInTheDocument();
    // No refund or void may be offered against a receipt nobody has read.
    expect(screen.queryByRole('button', { name: 'Void sale' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Return items' })).not.toBeInTheDocument();
  });
});

describe('Orders — the branch clock', () => {
  it('dates a receipt by the branch, not by the machine reading it', () => {
    // 20:30 UTC is 02:00 the next morning in Bengaluru. A manager in London
    // must see the day the till saw, or the sale files itself against the
    // wrong day's takings.
    const late = order({ createdAt: '2026-08-18T20:30:00.000Z' });
    open({ orders: [late], timeZone: 'Asia/Kolkata' });
    expect(screen.getByText(/19 Aug/)).toBeInTheDocument();

    cleanup();
    open({ orders: [late], timeZone: 'Europe/London' });
    expect(screen.getByText(/18 Aug/)).toBeInTheDocument();
  });
});

describe('Orders — cost at sale', () => {
  it('shows the cost captured on a line to a role that holds inventory.manage', async () => {
    const user = userEvent.setup();
    // A branch manager: `inventory.manage`, no `report.financial`. The server
    // sends the unit cost and says so in `restricted`; the panel must agree.
    apiMock.mockResolvedValue({
      ...detail,
      financial: { canSeeMargin: false, canSeeCost: true, restricted: ['marginMinor', 'valuationMinor', 'shrinkageCostMinor'] },
    });
    open();

    await user.click(screen.getByRole('button', { name: /SF-20260818-AB12C/ }));
    expect(await screen.findByText('Cost at sale')).toBeInTheDocument();
    expect(screen.getByText('₹200.00')).toBeInTheDocument();
  });

  it('withholds it from a role that does not', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue({
      ...detail,
      lines: [{ ...detail.lines[0]!, unitCostMinor: null }],
      financial: noFinancials,
    });
    open();

    await user.click(screen.getByRole('button', { name: /SF-20260818-AB12C/ }));
    await screen.findByRole('dialog');
    expect(screen.queryByText('Cost at sale')).not.toBeInTheDocument();
  });
});
