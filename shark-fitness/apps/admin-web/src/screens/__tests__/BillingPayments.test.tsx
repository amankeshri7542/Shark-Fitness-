import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiMock = vi.hoisted(() => vi.fn());
const permissions = vi.hoisted(() => ({ granted: new Set<string>(['billing.view', 'billing.record_payment', 'billing.refund']) }));

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, api: apiMock };
});
vi.mock('../../lib/store', () => ({ usePermission: (permission: string) => permissions.granted.has(permission) }));

import { ApiError } from '../../lib/api';
import { PaymentLinkSection, type PaymentLinkView } from '../billing/PaymentLinkSection';
import { ReconciliationPanel } from '../billing/ReconciliationPanel';

/* P02 acceptance 10: the payment-link action and the reconciliation panel. */

const link: PaymentLinkView = {
  intentId: 'pi_link',
  url: 'https://rzp.io/i/abc123',
  state: 'active',
  expiresAt: '2026-12-02T10:00:00.000Z',
  amountLabel: '₹2,950',
  createdByName: 'Riya Reception',
  createdAt: '2026-11-25T10:00:00.000Z',
};

const exception = {
  id: 'rex_1',
  kind: 'amount_mismatch',
  title: 'Amount does not match',
  detail: 'Razorpay captured 100; this checkout was for 295000 (minor units).',
  state: 'open',
  invoiceId: 'inv_1',
  invoiceNumber: 'SF-2026-00042',
  memberName: 'Aman Verma',
  providerPaymentId: 'pay_Mismatch001',
  providerRefundId: null,
  expectedLabel: '₹2,950',
  receivedLabel: '₹1',
  createdAt: '2026-11-25T10:00:00.000Z',
};

function wrap(children: React.ReactNode) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>);
}

beforeEach(() => {
  permissions.granted = new Set(['billing.view', 'billing.record_payment', 'billing.refund']);
});
afterEach(() => vi.clearAllMocks());

describe('payment link action', () => {
  it('creates a link with an idempotency key and shows it, its expiry, and that nothing was sent', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(link);
    const onCreated = vi.fn();
    wrap(<PaymentLinkSection invoiceId="inv_1" links={[]} canCreate payable onCreated={onCreated} />);
    expect(screen.getByText(/Nothing is sent to the member/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create payment link' }));

    expect(await screen.findByDisplayValue('https://rzp.io/i/abc123')).toHaveAttribute('readonly');
    expect(apiMock).toHaveBeenCalledWith('/admin/billing/invoices/inv_1/payment-link', expect.objectContaining({ method: 'POST', idempotencyKey: expect.any(String) }));
    expect(screen.getByText(/Expires/)).toHaveTextContent('Nothing has been sent to the member: share it with them yourself.');
    expect(onCreated).toHaveBeenCalledOnce();
  });

  it('copies the link', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    wrap(<PaymentLinkSection invoiceId="inv_1" links={[link]} canCreate payable onCreated={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('https://rzp.io/i/abc123');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('shows the server’s reason when Razorpay could not create the link, and the same attempt is retried', async () => {
    const user = userEvent.setup();
    apiMock.mockRejectedValueOnce(new ApiError(503, { error: { code: 'PROVIDER_UNAVAILABLE', message: 'Razorpay could not create the link just now. Nothing was sent to the member. Try again in a moment.', requestId: 'req_1' } }));
    apiMock.mockResolvedValueOnce(link);
    wrap(<PaymentLinkSection invoiceId="inv_1" links={[]} canCreate payable onCreated={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Create payment link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Razorpay could not create the link just now.');
    await user.click(screen.getByRole('button', { name: 'Create payment link' }));
    await screen.findByDisplayValue('https://rzp.io/i/abc123');
    const [first, second] = apiMock.mock.calls;
    expect(second![1].idempotencyKey).toBe(first![1].idempotencyKey);
  });

  it('offers nothing to staff who cannot record payments, or when nothing is owed', () => {
    const { unmount } = wrap(<PaymentLinkSection invoiceId="inv_1" links={[]} canCreate={false} payable onCreated={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Create payment link' })).not.toBeInTheDocument();
    expect(screen.getByText('Staff who record payments can create a link for this invoice.')).toBeInTheDocument();
    unmount();
    wrap(<PaymentLinkSection invoiceId="inv_1" links={[{ ...link, state: 'paid' }]} canCreate payable={false} onCreated={vi.fn()} />);
    expect(screen.getByText('Nothing is owed on this invoice.')).toBeInTheDocument();
    expect(screen.getByText('paid')).toBeInTheDocument();
  });
});

describe('reconciliation panel', () => {
  it('shows a loading state, then open exceptions with expected and received amounts', async () => {
    let release!: (value: unknown) => void;
    apiMock.mockImplementation(() => new Promise((done) => (release = done)));
    const onOpenInvoice = vi.fn();
    wrap(<ReconciliationPanel onOpenInvoice={onOpenInvoice} />);
    expect(screen.getByRole('region', { name: 'Reconciliation' }).querySelector('[aria-busy="true"]')).not.toBeNull();
    release({ onlinePayment: true, items: [exception] });
    const panel = await screen.findByRole('region', { name: 'Reconciliation · 1 open' });
    expect(panel).toHaveTextContent('Amount does not match');
    expect(panel).toHaveTextContent('Expected₹2,950');
    expect(panel).toHaveTextContent('Received₹1');
    expect(panel).toHaveTextContent('pay_Mismatch001');
    await userEvent.setup().click(within(panel).getByRole('button', { name: 'Aman Verma · SF-2026-00042' }));
    expect(onOpenInvoice).toHaveBeenCalledWith('inv_1');
  });

  it('says plainly when there is nothing to reconcile', async () => {
    apiMock.mockResolvedValue({ onlinePayment: true, items: [] });
    wrap(<ReconciliationPanel onOpenInvoice={vi.fn()} />);
    expect(await screen.findByText('Nothing to reconcile. Every payment Razorpay reported matched an invoice.')).toBeInTheDocument();
  });

  it('stays out of the way when online payment is not connected and there is nothing open', async () => {
    apiMock.mockResolvedValue({ onlinePayment: false, items: [] });
    const { container } = wrap(<ReconciliationPanel onOpenInvoice={vi.fn()} />);
    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('shows an error with a retry', async () => {
    const user = userEvent.setup();
    apiMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ onlinePayment: true, items: [] });
    wrap(<ReconciliationPanel onOpenInvoice={vi.fn()} />);
    expect(await screen.findByText('Could not load reconciliation')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/Nothing to reconcile/)).toBeInTheDocument();
  });

  it('is read-only without billing.refund', async () => {
    permissions.granted = new Set(['billing.view', 'billing.record_payment']);
    apiMock.mockResolvedValue({ onlinePayment: true, items: [exception] });
    wrap(<ReconciliationPanel onOpenInvoice={vi.fn()} />);
    expect(await screen.findByText('Owners and accounts staff resolve these.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ignore' })).not.toBeInTheDocument();
  });

  it('resolving needs a reason, then records it and refreshes the list', async () => {
    const user = userEvent.setup();
    let open = [exception];
    apiMock.mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
      if (options?.method === 'POST') {
        open = [];
        return { ok: true, id: 'rex_1', state: 'resolved' };
      }
      return { onlinePayment: true, items: open };
    });
    wrap(<ReconciliationPanel onOpenInvoice={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Resolve' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Resolve this exception' });
    expect(dialog).toHaveTextContent('Nothing is refunded or charged from here');
    const confirm = within(dialog).getByRole('button', { name: 'Resolve' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox'), 'Refunded the ₹1 test payment');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/admin/billing/reconciliation/rex_1/resolve', { method: 'POST', body: { action: 'resolve', reason: 'Refunded the ₹1 test payment' } }));
    expect(await screen.findByText(/Nothing to reconcile/)).toBeInTheDocument();
  });
});
