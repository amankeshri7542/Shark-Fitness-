import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiMock = vi.hoisted(() => vi.fn());

vi.mock('../../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/api')>();
  return { ...actual, api: apiMock };
});

// `restoreMocks: true` in vitest.config.ts clears call history and the
// implementation between tests, so each case sets up only what it needs.
import Register from '../Register';
import { product, renderPanel } from './harness';

/* The till is where money is taken, so these assert the arithmetic and the
   conditions under which the button is allowed to be pressed at all. */

function open(overrides: Partial<Parameters<typeof Register>[0]> = {}) {
  return renderPanel(
    <Register
      products={[product()]}
      loading={false}
      branchId="br_kor"
      branchName="Koramangala"
      canManage
      online
      {...overrides}
    />,
  );
}

describe('Register — mixed tender', () => {
  it('prices a line the way the server does: tax on the discounted amount', async () => {
    const user = userEvent.setup();
    open();

    await user.click(screen.getByRole('button', { name: /Add Shark Tee — M/ }));

    const totals = within(screen.getByRole('region', { name: 'Sale totals' }));
    expect(totals.getByText('₹1,000.00')).toBeInTheDocument(); // subtotal
    expect(totals.getByText('₹180.00')).toBeInTheDocument(); // tax
    expect(totals.getByText('₹1,180.00')).toBeInTheDocument(); // total
  });

  it('counts the remaining balance down as tenders are added', async () => {
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole('button', { name: /Add Shark Tee — M/ }));

    // A fresh tender defaults to whatever is still owed.
    await user.click(screen.getByRole('button', { name: 'Cash' }));
    const cash = screen.getByLabelText(/Cash amount in rupees/);
    expect(cash).toHaveValue(1180);

    // Take ₹500 in cash; ₹680 is still to collect.
    await user.clear(cash);
    await user.type(cash, '500');
    expect(screen.getByText('Remaining')).toBeInTheDocument();
    expect(screen.getByText('₹680.00')).toBeInTheDocument();

    // The rest on a card settles it exactly.
    await user.click(screen.getByRole('button', { name: 'Card' }));
    expect(screen.getByLabelText(/Card amount in rupees/)).toHaveValue(680);
    expect(screen.getByText('Settled')).toBeInTheDocument();
  });

  it('refuses to take payment until the tender adds up exactly', async () => {
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole('button', { name: /Add Shark Tee — M/ }));
    await user.click(screen.getByRole('button', { name: 'Cash' }));

    const cash = screen.getByLabelText(/Cash amount in rupees/);
    await user.clear(cash);
    await user.type(cash, '900');

    // Letting this round would create or destroy money in the day's takings.
    const take = screen.getByRole('button', { name: /still to collect/ });
    expect(take).toBeDisabled();

    await user.clear(cash);
    await user.type(cash, '1180');
    expect(screen.getByRole('button', { name: /Take ₹1,180.00/ })).toBeEnabled();
  });

  it('names over-tendering rather than silently treating it as settled', async () => {
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole('button', { name: /Add Shark Tee — M/ }));
    await user.click(screen.getByRole('button', { name: 'Cash' }));

    const cash = screen.getByLabelText(/Cash amount in rupees/);
    await user.clear(cash);
    await user.type(cash, '2000');

    expect(screen.getByText('Over-tendered')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /still to return/ })).toBeDisabled();
  });

  it('takes the discount off before tax, exactly as the server does', async () => {
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole('button', { name: /Add Shark Tee — M/ }));

    await user.clear(screen.getByLabelText(/Discount on Shark Tee — M in rupees/));
    await user.type(screen.getByLabelText(/Discount on Shark Tee — M in rupees/), '100');

    // ₹900 taxable → ₹162 tax → ₹1,062 total.
    const totals = within(screen.getByRole('region', { name: 'Sale totals' }));
    expect(totals.getByText('₹162.00')).toBeInTheDocument();
    expect(totals.getByText('₹1,062.00')).toBeInTheDocument();
  });

  it('says an account charge needs a member before the sale is attempted', async () => {
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole('button', { name: /Add Shark Tee — M/ }));
    await user.click(screen.getByRole('button', { name: 'On account' }));

    expect(screen.getByText(/An account charge needs a member/)).toBeInTheDocument();
  });
});

describe('Register — when it must not sell', () => {
  it('will not open a till without a branch, and says why', () => {
    open({ branchId: null, branchName: 'All branches (3)' });

    expect(screen.getByText('Pick a branch to open the till')).toBeInTheDocument();
    expect(screen.getByText(/A till belongs to one shop floor/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add Shark Tee/ })).not.toBeInTheDocument();
  });

  it('tells a read-only role it can look but not sell', () => {
    open({ canManage: false });

    expect(screen.getByText('Not available to your role')).toBeInTheDocument();
    expect(screen.getByText(/can read the shop but not take a sale/)).toBeInTheDocument();
  });

  it('refuses the sale while offline instead of queuing money', async () => {
    const user = userEvent.setup();
    open({ online: false });

    await user.click(screen.getByRole('button', { name: /Add Shark Tee — M/ }));
    await user.click(screen.getByRole('button', { name: 'Cash' }));

    const take = screen.getByRole('button', { name: /Offline — cannot take payment/ });
    expect(take).toBeDisabled();
    await user.click(take);
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('will not add more of an item than the shelf holds', async () => {
    const user = userEvent.setup();
    open({ products: [product({ onHand: 1 })] });

    await user.click(screen.getByRole('button', { name: /Add Shark Tee — M/ }));
    expect(screen.getByRole('button', { name: 'Add one Shark Tee — M' })).toBeDisabled();
  });

  it('does not offer a sold-out item at all', () => {
    open({ products: [product({ onHand: 0 })] });
    expect(screen.getByRole('button', { name: /Add Shark Tee — M/ })).toBeDisabled();
  });
});

describe('Register — the receipt', () => {
  const soldResponse = {
    order: {
      id: 'pos_9',
      reference: 'SF-20260818-ZZ99Z',
      totalMinor: 118_000,
      invoiceId: null,
      memberName: null,
    },
    lines: [{ id: 'pol_1', name: 'Shark Tee — M', quantity: 1, totalMinor: 118_000 }],
    tenders: [{ id: 'pay_1', method: 'cash', amountMinor: 118_000, reference: '' }],
    financial: { canSeeMargin: true, canSeeCost: true, restricted: [] },
  };

  it('shows the server’s receipt, not a local echo of the basket', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(soldResponse);
    open();

    await user.click(screen.getByRole('button', { name: /Add Shark Tee — M/ }));
    await user.click(screen.getByRole('button', { name: 'Cash' }));
    await user.click(screen.getByRole('button', { name: /Take ₹1,180.00/ }));

    await waitFor(() => expect(screen.getByText('Sold')).toBeInTheDocument());
    // The reference is one the client could not have invented.
    expect(screen.getByText(/SF-20260818-ZZ99Z/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New sale' })).toBeInTheDocument();
  });

  it('keeps the basket intact when the sale is refused', async () => {
    const user = userEvent.setup();
    const { ApiError } = await import('../../../lib/api');
    apiMock.mockImplementation(() => {
      const rejected = Promise.reject(
        new ApiError(422, {
          error: { code: 'VALIDATION_FAILED', message: 'Only 0 in stock at this branch.', requestId: 'req_1' },
        }),
      );
      // The component handles this through the mutation's onError. The extra
      // catch only stops Vitest's unhandled-rejection guard from failing the
      // run before React Query gets to it — it does not swallow anything.
      rejected.catch(() => undefined);
      return rejected;
    });
    open();

    await user.click(screen.getByRole('button', { name: /Add Shark Tee — M/ }));
    await user.click(screen.getByRole('button', { name: 'Cash' }));
    // fireEvent rather than userEvent: userEvent flushes inside `act()`, which
    // rethrows the rejection this test is deliberately provoking and fails the
    // case before the component has had a chance to render its error state.
    fireEvent.click(screen.getByRole('button', { name: /Take ₹1,180.00/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Only 0 in stock/));
    // Nothing was sold, so the operator keeps what they had rung up.
    const totals = within(screen.getByRole('region', { name: 'Sale totals' }));
    expect(totals.getByText('₹1,180.00')).toBeInTheDocument();
    expect(screen.queryByText('Sold')).not.toBeInTheDocument();
  });
});
