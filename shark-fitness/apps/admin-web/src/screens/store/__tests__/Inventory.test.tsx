import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiMock = vi.hoisted(() => vi.fn());

vi.mock('../../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/api')>();
  return { ...actual, api: apiMock };
});

import Inventory from '../Inventory';
import { TZ, allowAll, noFinancials, product, renderPanel } from './harness';

/** The panel refetches after a successful write, so the call under test is not
 *  necessarily the last one. Pick it out by path and method instead. */
function callTo(path: string, method?: string) {
  return apiMock.mock.calls.find(
    ([p, options]) => p === path && (method === undefined || (options as { method?: string } | undefined)?.method === method),
  ) as [string, { method?: string; body?: unknown }] | undefined;
}

function open(overrides: Partial<Parameters<typeof Inventory>[0]> = {}) {
  return renderPanel(
    <Inventory
      products={[product()]}
      financial={allowAll}
      loading={false}
      branchId="br_kor"
      canManage
      online
      timeZone={TZ}
      {...overrides}
    />,
  );
}

/** Empty ledger so opening a product drawer does not hang on a pending query. */
const emptyLedger = { items: [], financial: allowAll };

describe('Inventory — the catalogue table', () => {
  it('shows what the shop needs to run: stock, reorder point and price', () => {
    open();
    // A row is a row. It was `role="button"`, which took the table's rows out
    // of the accessibility tree entirely; the control that opens it lives in
    // the cell instead, so both queries below have to keep working.
    const row = screen.getByRole('row', { name: /Shark Tee/ });
    expect(within(row).getByText('TEE-M')).toBeInTheDocument();
    expect(within(row).getByText('Coastal Apparel')).toBeInTheDocument();
    expect(within(row).getByText('₹1,000.00')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Shark Tee — M' })).toBeInTheDocument();
  });

  it('opens a product from the keyboard without the row pretending to be a button', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(emptyLedger);
    open();

    // Tab reaches the row's own control — the row itself is not a tab stop,
    // because a row is not an interactive element.
    const opener = screen.getByRole('row', { name: /Shark Tee/ }).querySelector('button');
    opener!.focus();
    await user.keyboard('{Enter}');

    expect(await screen.findByRole('dialog', { name: 'Shark Tee — M' })).toBeInTheDocument();
  });

  it('filters to what needs reordering', async () => {
    const user = userEvent.setup();
    open({
      products: [product(), product({ id: 'rtl_2', displayName: 'Shaker', sku: 'SHK', onHand: 2, lowStock: true })],
    });

    await user.click(screen.getByRole('button', { name: 'Low stock' }));

    expect(screen.getByText('Shaker')).toBeInTheDocument();
    expect(screen.queryByText('Shark Tee — M')).not.toBeInTheDocument();
  });

  it('keeps a retired product out of the active list but findable', async () => {
    const user = userEvent.setup();
    open({ products: [product({ active: false })] });

    expect(screen.getByText('Nothing matches')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retired' }));
    expect(screen.getByText('Shark Tee — M')).toBeInTheDocument();
  });

  it('offers no editing controls to a role that may only look', () => {
    open({ canManage: false });

    expect(screen.queryByRole('button', { name: 'New product' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Suppliers' })).not.toBeInTheDocument();
  });
});

describe('Inventory — financial visibility', () => {
  it('says cost and stock value are restricted rather than showing a zero', () => {
    open({
      products: [product({ costMinor: null, valuationMinor: null })],
      financial: noFinancials,
    });

    // Two restricted cells on the row: cost and stock value. Neither may read
    // as ₹0.00, which is a real and very different figure in a shop.
    expect(screen.getAllByText('Restricted')).toHaveLength(2);
    expect(screen.queryByText('₹0.00')).not.toBeInTheDocument();
  });

  it('shows cost to a role that may see it', () => {
    open();
    expect(screen.getByText('₹400.00')).toBeInTheDocument();
    expect(screen.queryByText('Restricted')).not.toBeInTheDocument();
  });

  it('drops the unit-cost column from the ledger when cost is withheld', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue({ items: [], financial: noFinancials });
    open({ products: [product({ costMinor: null, valuationMinor: null })], financial: noFinancials });

    await user.click(screen.getByRole('button', { name: /Shark Tee/ }));

    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).queryByText('Unit cost')).not.toBeInTheDocument();
  });
});

describe('Inventory — product create and edit', () => {
  it('creates a product from the drawer', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue({ product: {} });
    open();

    await user.click(screen.getByRole('button', { name: 'New product' }));
    const drawer = await screen.findByRole('dialog', { name: 'New product' });

    await user.type(within(drawer).getByLabelText('Name'), 'Resistance Band');
    await user.type(within(drawer).getByLabelText('SKU'), 'BAND-L');
    await user.type(within(drawer).getByLabelText('Category'), 'Accessories');
    await user.clear(within(drawer).getByLabelText('Price (₹)'));
    await user.type(within(drawer).getByLabelText('Price (₹)'), '450');

    await user.click(within(drawer).getByRole('button', { name: 'Add to catalogue' }));

    await waitFor(() => expect(callTo('/admin/store/products', 'POST')).toBeDefined());
    // Rupees in the form, minor units on the wire.
    expect(callTo('/admin/store/products', 'POST')![1].body).toMatchObject({
      name: 'Resistance Band',
      sku: 'BAND-L',
      priceMinor: 45_000,
    });
  });

  it('will not save a product without a name, SKU and category', async () => {
    const user = userEvent.setup();
    open();

    await user.click(screen.getByRole('button', { name: 'New product' }));
    const drawer = await screen.findByRole('dialog', { name: 'New product' });

    expect(within(drawer).getByRole('button', { name: 'Add to catalogue' })).toBeDisabled();
    await user.type(within(drawer).getByLabelText('Name'), 'Band');
    expect(within(drawer).getByRole('button', { name: 'Add to catalogue' })).toBeDisabled();
  });

  it('edits an existing product through PATCH, seeded from the record', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(emptyLedger);
    open();

    await user.click(screen.getByRole('button', { name: /Shark Tee/ }));
    await user.click(await screen.findByRole('button', { name: 'Edit product' }));

    const form = await screen.findByRole('dialog', { name: 'Shark Tee' });
    expect(within(form).getByLabelText('SKU')).toHaveValue('TEE-M');
    expect(within(form).getByLabelText('Price (₹)')).toHaveValue(1000);

    apiMock.mockResolvedValue({ product: {} });
    await user.clear(within(form).getByLabelText('Price (₹)'));
    await user.type(within(form).getByLabelText('Price (₹)'), '1200');
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(callTo('/admin/store/products/rtl_tee', 'PATCH')).toBeDefined());
    expect(callTo('/admin/store/products/rtl_tee', 'PATCH')![1].body).toMatchObject({ priceMinor: 120_000 });
  });
});

describe('Inventory — stock adjustment', () => {
  it('posts a signed movement with a reason instead of setting a quantity', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(emptyLedger);
    open();

    await user.click(screen.getByRole('button', { name: /Shark Tee/ }));
    const drawer = await screen.findByRole('dialog');

    await user.type(within(drawer).getByLabelText(/Stock change/), '-3');
    await user.click(within(drawer).getByRole('button', { name: 'Damage' }));
    await user.type(within(drawer).getByLabelText('Adjustment note'), 'Water damage in the stockroom');

    apiMock.mockResolvedValue({ productId: 'rtl_tee', branchId: 'br_kor', onHand: 9, lowStock: false });
    await user.click(within(drawer).getByRole('button', { name: /Record −?-?3/ }));

    await waitFor(() => expect(callTo('/admin/store/products/rtl_tee/stock', 'POST')).toBeDefined());
    // A delta, never an absolute count — the ledger is the source of truth.
    expect(callTo('/admin/store/products/rtl_tee/stock', 'POST')![1].body).toMatchObject({
      delta: -3,
      reason: 'damage',
      branchId: 'br_kor',
    });
  });

  it('refuses to adjust stock with no branch chosen, and says why', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(emptyLedger);
    open({ branchId: null });

    await user.click(screen.getByRole('button', { name: /Shark Tee/ }));
    const drawer = await screen.findByRole('dialog');

    expect(within(drawer).getByText(/Stock belongs to a branch/)).toBeInTheDocument();
    expect(within(drawer).queryByLabelText(/Stock change/)).not.toBeInTheDocument();
  });

  it('hides the adjustment controls from a read-only role', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(emptyLedger);
    open({ canManage: false });

    await user.click(screen.getByRole('button', { name: /Shark Tee/ }));
    const drawer = await screen.findByRole('dialog');

    expect(within(drawer).queryByText('Adjust stock')).not.toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: 'Edit product' })).not.toBeInTheDocument();
    // The ledger itself stays readable — seeing history is not managing it.
    expect(within(drawer).getByText('Movement ledger')).toBeInTheDocument();
  });
});

describe('Inventory — states other than a table of rows', () => {
  it('says the ledger could not be read rather than "nothing has moved yet"', async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation(() => {
      const rejected = Promise.reject(new Error('boom'));
      rejected.catch(() => undefined);
      return rejected;
    });
    open();

    await user.click(screen.getByRole('button', { name: /Shark Tee/ }));

    // "Nothing has moved yet" against a product that has moved forty times is
    // the worst thing this panel could say, and it is what it used to say.
    expect(await screen.findByText('Could not load the movement history')).toBeInTheDocument();
    expect(screen.queryByText(/Nothing has moved yet/)).not.toBeInTheDocument();
  });

  it('offers no stock write at all while offline', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(emptyLedger);
    open({ online: false });

    expect(screen.getByRole('button', { name: 'Offline' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /Shark Tee/ }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByRole('button', { name: /Offline — cannot adjust stock/ })).toBeDisabled();
    expect(within(drawer).getByRole('button', { name: /Offline — cannot edit/ })).toBeDisabled();
  });

  it('dates a ledger row by the branch clock', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue({
      items: [
        {
          id: 'stk_1',
          productId: 'rtl_tee',
          branchId: 'br_kor',
          branchName: 'Koramangala',
          delta: 24,
          reason: 'purchase',
          refType: null,
          refId: null,
          actorName: 'Sunita Rao',
          note: null,
          unitCostMinor: 40_000,
          negativeOverride: false,
          overrideReason: null,
          at: '2026-08-18T20:30:00.000Z',
        },
      ],
      financial: allowAll,
    });
    open({ timeZone: 'Asia/Kolkata' });

    await user.click(screen.getByRole('button', { name: /Shark Tee/ }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText(/19 Aug/)).toBeInTheDocument();
  });
});
