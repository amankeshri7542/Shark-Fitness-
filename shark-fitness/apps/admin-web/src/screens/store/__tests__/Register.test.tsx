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

/** What the server sends back for a one-line cash sale. */
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

/** The `Idempotency-Key` header the nth checkout POST carried. */
function checkoutKeys(): string[] {
  return apiMock.mock.calls
    .filter(([path, options]) => path === '/admin/store/orders' && (options as { method?: string }).method === 'POST')
    .map(([, options]) => (options as { idempotencyKey: string }).idempotencyKey);
}

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

  it('will not send an account tender with no member, settled or not', async () => {
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole('button', { name: /Add Shark Tee — M/ }));
    // A fresh tender defaults to the full balance, so the sale is *settled* —
    // the remaining balance reads zero and the old button read "Take
    // ₹1,180.00" and was enabled. `invoices.member_id` is NOT NULL, so the
    // server was always going to refuse it; spending a round trip to be told
    // that, in front of a customer, is the part worth fixing. The server stays
    // authoritative — the API test asserts the refusal — but the till knows.
    await user.click(screen.getByRole('button', { name: 'On account' }));
    expect(screen.getByText('Settled')).toBeInTheDocument();

    const take = screen.getByRole('button', { name: 'Attach a member to charge an account' });
    expect(take).toBeDisabled();
    await user.click(take);
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('takes the sale once a member is attached to the account tender', async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation((path: string) =>
      path.startsWith('/admin/members')
        ? Promise.resolve({
            // Exactly what `/admin/members` serves: one `name`. The fixture
            // used to invent `firstName`/`lastName`, which hid a picker that
            // rendered every result as a blank line above its member number.
            items: [{ id: 'mbr_1', memberNo: 'SF-0001', name: 'Asha Iyer', lifecycle: 'active' }],
          })
        : Promise.resolve(soldResponse),
    );
    open();

    await user.click(screen.getByRole('button', { name: /Add Shark Tee — M/ }));
    await user.click(screen.getByRole('button', { name: 'On account' }));
    await user.type(screen.getByLabelText(/Attach a member to this sale/), 'Asha');

    await user.click(await screen.findByRole('button', { name: /Asha Iyer/ }));
    expect(await screen.findByRole('button', { name: /Take ₹1,180.00/ })).toBeEnabled();
    // The attached member is named, not just numbered.
    expect(screen.getByText('Asha Iyer')).toBeInTheDocument();
    expect(screen.getByText(/SF-0001/)).toBeInTheDocument();
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

/* ============================================================================
   Idempotency.

   The failure these guard against is the worst one a till has: the server
   commits the sale, the response is lost on the way back, the cashier sees an
   error and presses the button again. Whether that charges the customer twice
   is decided entirely by whether the second request carries the same
   `Idempotency-Key` as the first.

   It did not. The key was built inside `mutationFn`, and `idempotencyKey()`
   appends a random suffix to everything it returns, so every press minted a
   new one and the server — correctly, given a new key — sold the goods again.
   ========================================================================= */

describe('Register — one attempt, one key', () => {
  it('retries a lost sale under the same key rather than selling twice', async () => {
    const user = userEvent.setup();
    const { OfflineError } = await import('../../../lib/api');

    // The server committed; the response never arrived. `fetch` rejecting is
    // exactly what that looks like from here, and it is indistinguishable from
    // "nothing happened" — which is why the key has to survive it.
    apiMock.mockImplementationOnce(() => {
      const rejected = Promise.reject(new OfflineError());
      rejected.catch(() => undefined);
      return rejected;
    });
    apiMock.mockResolvedValue(soldResponse);
    open();

    await user.click(screen.getByRole('button', { name: /Add Shark Tee — M/ }));
    await user.click(screen.getByRole('button', { name: 'Cash' }));
    fireEvent.click(screen.getByRole('button', { name: /Take ₹1,180.00/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/No connection/));
    // The basket is intact, because as far as this screen knows nothing sold.
    await user.click(screen.getByRole('button', { name: /Take ₹1,180.00/ }));
    await waitFor(() => expect(screen.getByText('Sold')).toBeInTheDocument());

    const keys = checkoutKeys();
    expect(keys).toHaveLength(2);
    // One logical checkout, one key: the second request is answered from the
    // first one's record, so one order, one payment and one stock movement.
    expect(keys[0]).toBe(keys[1]);
  });

  it('keeps the key across a refusal so a corrected retry cannot double-sell', async () => {
    const user = userEvent.setup();
    const { ApiError } = await import('../../../lib/api');
    apiMock.mockImplementationOnce(() => {
      const rejected = Promise.reject(
        new ApiError(500, { error: { code: 'INTERNAL', message: 'Something failed.', requestId: 'req_2' } }),
      );
      rejected.catch(() => undefined);
      return rejected;
    });
    apiMock.mockResolvedValue(soldResponse);
    open();

    await user.click(screen.getByRole('button', { name: /Add Shark Tee — M/ }));
    await user.click(screen.getByRole('button', { name: 'Cash' }));
    fireEvent.click(screen.getByRole('button', { name: /Take ₹1,180.00/ }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Take ₹1,180.00/ }));
    await waitFor(() => expect(screen.getByText('Sold')).toBeInTheDocument());

    // A 5xx is precisely the case where the client cannot know whether the
    // write landed, so the retry must be the same question, not a new one.
    expect(checkoutKeys()[0]).toBe(checkoutKeys()[1]);
  });

  it('mints a new key when the basket changes, because that is a different sale', async () => {
    const user = userEvent.setup();
    const { OfflineError } = await import('../../../lib/api');
    apiMock.mockImplementationOnce(() => {
      const rejected = Promise.reject(new OfflineError());
      rejected.catch(() => undefined);
      return rejected;
    });
    apiMock.mockResolvedValue(soldResponse);
    open();

    await user.click(screen.getByRole('button', { name: /Add Shark Tee — M/ }));
    await user.click(screen.getByRole('button', { name: 'Cash' }));
    fireEvent.click(screen.getByRole('button', { name: /Take ₹1,180.00/ }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    // A second unit. Reusing the key here would be worse than useless: the
    // server hashes the body alongside the key and would refuse the whole
    // thing as a conflicting replay.
    await user.click(screen.getByRole('button', { name: 'Add one Shark Tee — M' }));
    await user.click(screen.getByRole('button', { name: 'Cash' }));
    fireEvent.click(screen.getByRole('button', { name: /Take ₹2,360.00/ }));
    await waitFor(() => expect(screen.getByText('Sold')).toBeInTheDocument());

    const keys = checkoutKeys();
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('gives the next customer a new key even for an identical basket', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(soldResponse);
    open();

    // Two people in a row buy the same tee and pay cash. The request bodies are
    // byte-identical, so a key keyed only on the basket would replay the first
    // receipt and swallow a real second sale — the mirror image of the double
    // charge, and just as expensive.
    await user.click(screen.getByRole('button', { name: /Add Shark Tee — M/ }));
    await user.click(screen.getByRole('button', { name: 'Cash' }));
    await user.click(screen.getByRole('button', { name: /Take ₹1,180.00/ }));
    await waitFor(() => expect(screen.getByText('Sold')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'New sale' }));
    await user.click(screen.getByRole('button', { name: /Add Shark Tee — M/ }));
    await user.click(screen.getByRole('button', { name: 'Cash' }));
    await user.click(screen.getByRole('button', { name: /Take ₹1,180.00/ }));
    await waitFor(() => expect(screen.getByText('Sold')).toBeInTheDocument());

    const keys = checkoutKeys();
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('sends the same body it fingerprinted', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(soldResponse);
    open();

    await user.click(screen.getByRole('button', { name: /Add Shark Tee — M/ }));
    await user.click(screen.getByRole('button', { name: 'Cash' }));
    await user.click(screen.getByRole('button', { name: /Take ₹1,180.00/ }));
    await waitFor(() => expect(screen.getByText('Sold')).toBeInTheDocument());

    // The server refuses a key replayed against a different request hash, so
    // the fingerprint has to be the body itself and nothing less.
    const [, options] = apiMock.mock.calls.find(([path]) => path === '/admin/store/orders')!;
    expect((options as { body: unknown }).body).toEqual({
      branchId: 'br_kor',
      memberId: null,
      lines: [{ productId: 'rtl_tee', quantity: 1, discountMinor: 0 }],
      payments: [{ method: 'cash', amountMinor: 118_000, reference: '' }],
    });
  });
});
