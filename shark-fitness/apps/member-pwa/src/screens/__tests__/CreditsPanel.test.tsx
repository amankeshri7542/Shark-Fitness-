import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CreditAccount } from '@shark/contracts';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/api')>()), api }));

import { ApiError } from '../../lib/api';
import { CreditsPanel } from '../billing/CreditsPanel';


afterEach(() => {
  cleanup();
  api.mockReset();
});

const offer = { productId: 'prd_class_10', name: 'Class Pack — 10', description: '', kind: 'class' as const, units: 10, validDays: 180, totalMinor: 707_882, totalLabel: '₹7,078.82', perCreditLabel: '₹707.88' };

function account(overrides: Partial<CreditAccount> = {}): CreditAccount {
  return {
    today: '2026-11-25',
    balances: [
      { kind: 'class', signedBalance: 6, usableUnits: 6, ledgerUnits: 6, consumptionAvailable: true, warning: null, nextExpiry: { units: 2, on: '2026-12-10' }, lots: [] },
      { kind: 'pt', signedBalance: 0, usableUnits: 0, ledgerUnits: 0, consumptionAvailable: true, warning: null, nextExpiry: null, lots: [] },
    ],
    entries: [],
    packs: [],
    offers: [offer],
    saleAvailable: true,
    saleUnavailableReason: '',
    historyNotice: 'Every change to your credits is listed here.',
    ...overrides,
  };
}

function renderPanel(props: Partial<Parameters<typeof CreditsPanel>[0]> = {}) {
  const pay = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
      <CreditsPanel credits={account()} online={false} busy={false} pay={pay} {...props} />
    </QueryClientProvider>,
  );
  return { pay };
}

it('shows each balance with when the soonest credits expire', () => {
  renderPanel();
  expect(screen.getByText('Class credits')).toBeInTheDocument();
  expect(screen.getByText('6')).toBeInTheDocument();
  expect(screen.getByText('2 expire on 10 Dec 2026')).toBeInTheDocument();
  expect(screen.getByText('None to use')).toBeInTheDocument();
});

it('buying asks first, with the total, validity and refund terms; without online payment it raises an invoice for reception', async () => {
  api.mockResolvedValue({ invoiceId: 'inv_1', payOnline: false, creditsAllocated: false, message: 'Your invoice is ready. Pay at reception and the credits are added straight away.' });
  const { pay } = renderPanel();
  fireEvent.click(screen.getByRole('button', { name: 'Buy Class Pack — 10 for ₹7,078.82' }));
  const dialog = await screen.findByRole('dialog', { name: 'Buy Class Pack — 10' });
  expect(dialog).toHaveTextContent('to use within 180 days of payment');
  expect(dialog).toHaveTextContent('Expired credits are not refundable.');
  expect(api).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Raise the invoice' }));
  expect(await screen.findByText(/Pay at reception and the credits are added/)).toBeInTheDocument();
  expect(api).toHaveBeenCalledWith('/member/billing/credit-packs', expect.objectContaining({ method: 'POST', body: { productId: 'prd_class_10' }, idempotencyKey: expect.stringMatching(/^pack:/) }));
  expect(pay).not.toHaveBeenCalled();
});

it('with online payment, buying continues straight into Checkout for the new invoice', async () => {
  api.mockResolvedValue({ invoiceId: 'inv_2', payOnline: true, creditsAllocated: false, message: 'Pay now and your credits are added as soon as the payment is confirmed.' });
  const { pay } = renderPanel({ online: true });
  fireEvent.click(screen.getByRole('button', { name: /Buy Class Pack/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Continue to pay ₹7,078.82' }));
  await waitFor(() => expect(pay).toHaveBeenCalledWith({ kind: 'invoice', invoiceId: 'inv_2', label: 'Class Pack — 10' }));
});

it('a failed purchase says nothing was bought, and Escape closes the dialog', async () => {
  api.mockRejectedValue(new TypeError('Failed to fetch'));
  renderPanel();
  fireEvent.click(screen.getByRole('button', { name: /Buy Class Pack/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Raise the invoice' }));
  expect(await screen.findByText(/Nothing was bought or charged/)).toBeInTheDocument();
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

it('a server refusal is shown in its own words', async () => {
  api.mockRejectedValue(new ApiError(422, { error: { code: 'VALIDATION_FAILED', message: 'That pack is not on sale.', requestId: 'r' } }));
  renderPanel();
  fireEvent.click(screen.getByRole('button', { name: /Buy Class Pack/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Raise the invoice' }));
  expect(await screen.findByText('That pack is not on sale.')).toBeInTheDocument();
});

it('a pack waiting for payment says when its credits arrive, and offers to pay online', () => {
  const pending = {
    id: 'cpk_1', productId: 'prd_class_10', productName: 'Class Pack — 10', kind: 'class' as const, units: 10, state: 'pending_payment', priceMinor: 707_882, priceLabel: '₹7,078.82',
    invoiceId: 'inv_9', invoiceNumber: 'SF-2026-00042', invoiceState: 'open', dueMinor: 707_882, soldBy: 'member', createdAt: '2026-11-25T10:00:00Z', allocatedAt: null, expiresOn: null,
    remaining: 0, used: 0, expired: false, refund: { refundable: false, kind: null, units: 0, amountMinor: 0, amountLabel: '₹0', message: '' },
  };
  const { pay } = renderPanel({ online: true, credits: account({ packs: [pending] }) });
  expect(screen.getByText('Invoice SF-2026-00042. The 10 credits are added once it is paid.')).toBeInTheDocument();
  expect(screen.getByText('Waiting for payment')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Pay ₹7,078.82 now' }));
  expect(pay).toHaveBeenCalledWith({ kind: 'invoice', invoiceId: 'inv_9', label: 'Class Pack — 10' });
});

it('nothing on sale: says so plainly', () => {
  renderPanel({ credits: account({ offers: [], saleAvailable: false, saleUnavailableReason: 'No credit packs are on sale at this branch right now.' }) });
  expect(screen.getByText('No credit packs are on sale at this branch right now.')).toBeInTheDocument();
});
