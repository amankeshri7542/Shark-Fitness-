import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, API_ORIGIN: '', api };
});

import Billing from '../Billing';
import { ApiError } from '../../lib/api';
import { CHECKOUT_SCRIPT_URL } from '../../lib/checkout';

/* P02 acceptance 9: every checkout state the member can see. Razorpay
   Checkout is replaced by a stand-in on window; the server by `api`. */

const invoice = { id: 'inv_1', number: 'SF-2026-00042', state: 'open', issuedOn: '2026-11-20', dueOn: '2026-11-27', totalLabel: '₹295', dueMinor: 29500, dueLabel: '₹295', payable: true };
const billing = (overrides: Record<string, unknown> = {}) => ({
  onlinePayment: { available: true, provider: 'razorpay', testMode: true },
  outstandingMinor: 29500,
  outstandingLabel: '₹295',
  membership: { id: 'msh_1', productName: 'Depot Monthly', state: 'pending_payment', endsOn: '2026-12-25', autoRenew: false, priceLabel: '₹250' },
  invoices: [invoice],
  receipts: [],
  ...overrides,
});
const session = {
  intentId: 'pi_1', invoiceId: 'inv_1', state: 'processing', amountLabel: '₹295', paymentId: null, failureReason: null,
  orderId: 'order_1', keyId: 'rzp_test_member', amountMinor: 29500, currency: 'INR', name: 'Shark Fitness', description: 'Invoice SF-2026-00042',
  prefill: { name: 'Aman Verma', email: 'aman@sharkfitness.in', contact: null },
};
const success = { razorpay_payment_id: 'pay_1', razorpay_order_id: 'order_1', razorpay_signature: 'sig' };

type Options = {
  key: string; order_id: string; amount: number; prefill: Record<string, string>; notes: Record<string, string>;
  handler: (response: typeof success) => void; modal: { ondismiss: () => void };
};
let opened: Array<{ options: Options; failed?: (response: unknown) => void }>;

class FakeRazorpay {
  entry: { options: Options; failed?: (response: unknown) => void };
  constructor(options: Options) {
    this.entry = { options };
  }
  on(event: string, handler: (response: unknown) => void) {
    if (event === 'payment.failed') this.entry.failed = handler;
  }
  open() {
    opened.push(this.entry);
  }
}

let server: Record<string, (options?: { body?: unknown; idempotencyKey?: string }) => unknown>;

beforeEach(() => {
  opened = [];
  window.Razorpay = FakeRazorpay as unknown as NonNullable<typeof window.Razorpay>;
  server = {
    'GET /member/billing': () => billing(),
    'POST /member/billing/invoices/inv_1/checkout': () => session,
  };
  api.mockImplementation(async (path: string, options: { method?: string; body?: unknown; idempotencyKey?: string } = {}) => {
    const handler = server[`${options.method ?? 'GET'} ${path}`];
    if (!handler) throw new Error(`Unexpected ${options.method ?? 'GET'} ${path}`);
    return handler(options);
  });
});
afterEach(() => {
  vi.clearAllMocks();
  delete window.Razorpay;
});

function renderBilling() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Billing /></QueryClientProvider>);
  return client;
}

const payButton = () => screen.findByRole('button', { name: 'Pay ₹295 now for invoice SF-2026-00042' });
const checkoutCalls = () => api.mock.calls.filter(([path]) => path === '/member/billing/invoices/inv_1/checkout');

it('offers Pay now with an honest test-mode notice instead of the reception-only copy', async () => {
  renderBilling();
  expect(await payButton()).toBeEnabled();
  expect(screen.getByText('Test mode')).toBeInTheDocument();
  expect(screen.getByText(/No real money moves/)).toBeInTheDocument();
  expect(screen.queryByText(/Online payment is unavailable/)).not.toBeInTheDocument();
  expect(screen.getByText(/starts as soon as its invoice below is paid/)).toBeInTheDocument();
});

it('shows opening while the order is created, then hands Razorpay the order and public key only', async () => {
  let release!: (value: unknown) => void;
  server['POST /member/billing/invoices/inv_1/checkout'] = () => new Promise((done) => (release = done));
  renderBilling();
  fireEvent.click(await payButton());
  expect(await screen.findByRole('status')).toHaveTextContent('Opening payment');
  expect(await payButton()).toBeDisabled();
  await act(async () => release(session));
  await waitFor(() => expect(opened).toHaveLength(1));
  expect(opened[0]!.options).toMatchObject({ key: 'rzp_test_member', order_id: 'order_1', amount: 29500, notes: { intent_id: 'pi_1', invoice_id: 'inv_1' } });
  expect(opened[0]!.options.prefill).toEqual({ name: 'Aman Verma', email: 'aman@sharkfitness.in' });
});

it('dismissed: says nothing was charged, and Try again reuses the same idempotency key and order', async () => {
  renderBilling();
  fireEvent.click(await payButton());
  await waitFor(() => expect(opened).toHaveLength(1));
  act(() => opened[0]!.options.modal.ondismiss());
  const status = await screen.findByRole('status');
  expect(status).toHaveTextContent('Payment not completed');
  expect(status).toHaveTextContent('Nothing was charged for invoice SF-2026-00042.');

  fireEvent.click(within(status).getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(opened).toHaveLength(2));
  const [first, second] = checkoutCalls();
  expect(first![1].idempotencyKey).toBeTruthy();
  expect(second![1].idempotencyKey).toBe(first![1].idempotencyKey);
  expect(opened[1]!.options.order_id).toBe('order_1');
});

it('failed: shows Razorpay’s reason in plain words with a retry when the member gives up after a failure', async () => {
  renderBilling();
  fireEvent.click(await payButton());
  await waitFor(() => expect(opened).toHaveLength(1));
  act(() => {
    opened[0]!.failed!({ error: { code: 'BAD_REQUEST_ERROR', description: 'Your bank declined this payment.', reason: 'payment_declined' } });
    opened[0]!.options.modal.ondismiss();
  });
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Payment did not go through');
  expect(alert).toHaveTextContent('Your bank declined this payment.');
  expect(alert).toHaveTextContent('You can also pay at reception.');
  expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
});

it('failed: a server refusal is shown as the server words it', async () => {
  server['POST /member/billing/invoices/inv_1/checkout'] = () => {
    throw new ApiError(503, { error: { code: 'PROVIDER_UNAVAILABLE', message: 'Online payment could not be started just now. Nothing was charged. Try again in a moment.', requestId: 'req_1' } });
  };
  renderBilling();
  fireEvent.click(await payButton());
  expect(await screen.findByRole('alert')).toHaveTextContent('Online payment could not be started just now. Nothing was charged.');
  expect(opened).toHaveLength(0);
});

it('failed: says so when the payment window itself cannot load, and only ever loads it from Razorpay', async () => {
  delete window.Razorpay;
  renderBilling();
  fireEvent.click(await payButton());
  await waitFor(() => expect(document.head.querySelector(`script[src="${CHECKOUT_SCRIPT_URL}"]`)).not.toBeNull());
  expect(CHECKOUT_SCRIPT_URL).toBe('https://checkout.razorpay.com/v1/checkout.js');
  const script = document.head.querySelector<HTMLScriptElement>(`script[src="${CHECKOUT_SCRIPT_URL}"]`)!;
  act(() => script.dispatchEvent(new Event('error')));
  expect(await screen.findByRole('alert')).toHaveTextContent('The secure payment window could not load.');
});

it('confirming, then paid: waits for the server, then shows the receipt', async () => {
  let statusCalls = 0;
  server['POST /member/billing/checkout/pi_1/confirm'] = ({ body } = {}) => {
    expect(body).toEqual(success);
    return { ...session, state: 'processing' };
  };
  server['GET /member/billing/checkout/pi_1'] = () => {
    statusCalls += 1;
    return statusCalls === 1
      ? { ...session, state: 'processing' }
      : { intentId: 'pi_1', invoiceId: 'inv_1', state: 'succeeded', amountLabel: '₹295', paymentId: 'pay_local_1', failureReason: null };
  };
  const client = renderBilling();
  fireEvent.click(await payButton());
  await waitFor(() => expect(opened).toHaveLength(1));
  act(() => opened[0]!.options.handler(success));
  const confirming = await screen.findByText('Confirming payment');
  expect(confirming.closest('[role="status"]')).toHaveTextContent('You will not be charged twice.');

  // A realtime event invalidates ['billing', …]; the status query asks again.
  server['GET /member/billing'] = () => billing({ outstandingMinor: 0, outstandingLabel: '₹0', invoices: [{ ...invoice, state: 'paid', dueMinor: 0, dueLabel: '₹0', payable: false }] });
  await act(() => client.invalidateQueries({ queryKey: ['billing'] }));
  const paid = await screen.findByText('Paid');
  const panel = paid.closest('[role="status"]')!;
  expect(panel).toHaveTextContent('₹295 received for invoice SF-2026-00042.');
  expect(within(panel as HTMLElement).getByRole('link', { name: 'View receipt' })).toHaveAttribute('href', '/v1/member/billing/payments/pay_local_1/receipt?format=html');
  expect(within(panel as HTMLElement).getByRole('link', { name: 'Download receipt' })).toHaveAttribute('href', '/v1/member/billing/payments/pay_local_1/receipt');
  // The paid invoice is no longer offered for payment.
  await waitFor(() => expect(screen.queryByRole('button', { name: /Pay ₹295 now/ })).not.toBeInTheDocument());
});

it('needs review: tells the member not to pay again', async () => {
  server['POST /member/billing/checkout/pi_1/confirm'] = () => ({ ...session, state: 'needs_review' });
  renderBilling();
  fireEvent.click(await payButton());
  await waitFor(() => expect(opened).toHaveLength(1));
  act(() => opened[0]!.options.handler(success));
  expect(await screen.findByText('Payment received, being checked')).toBeInTheDocument();
  expect(screen.getByText(/Do not pay again/)).toBeInTheDocument();
});

it('chooses a plan with its full price and terms before anything is invoiced', async () => {
  server['GET /member/billing'] = () => billing({ membership: null, invoices: [], outstandingMinor: 0, outstandingLabel: '₹0' });
  server['GET /member/billing/plans'] = () => ({
    onlinePayment: true, mode: 'purchase', unavailableReason: null, previousProductId: null,
    plans: [
      { productId: 'prd_month', name: 'Depot Monthly', description: '', kind: 'membership', durationDays: 30, priceLabel: '₹2,500', taxLabel: '₹450', totalMinor: 295000, totalLabel: '₹2,950', cancellation: 'Cancel with 7 days notice.', freezeAllowed: true },
      { productId: 'prd_quarter', name: 'Depot Quarterly', description: '', kind: 'membership', durationDays: 90, priceLabel: '₹6,500', taxLabel: '₹1,170', totalMinor: 767000, totalLabel: '₹7,670', cancellation: 'No refunds after 14 days.', freezeAllowed: true },
    ],
  });
  server['POST /member/billing/plans/prd_quarter/checkout'] = () => ({ kind: 'checkout', ...session, invoiceId: 'inv_new', amountMinor: 767000, amountLabel: '₹7,670' });
  renderBilling();
  fireEvent.click(await screen.findByRole('button', { name: 'Choose a plan' }));
  const dialog = await screen.findByRole('dialog', { name: 'Choose a plan' });
  await within(dialog).findByText('Depot Quarterly');
  fireEvent.click(within(dialog).getByRole('radio', { name: /Depot Quarterly/ }));
  expect(dialog).toHaveTextContent('Total today₹7,670');
  expect(dialog).toHaveTextContent('Cancellation: No refunds after 14 days.');
  expect(dialog).toHaveTextContent('It does not renew or charge you automatically.');
  // Nothing has been created yet.
  expect(api.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Pay ₹7,670' }));
  await waitFor(() => expect(opened).toHaveLength(1));
  expect(opened[0]!.options.amount).toBe(767000);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('a link from the website (?plan=) opens the plan sheet with that plan chosen, before anything is invoiced', async () => {
  window.history.replaceState(null, '', '/app/billing?plan=prd_quarter');
  server['GET /member/billing'] = () => billing({ membership: null, invoices: [], outstandingMinor: 0, outstandingLabel: '₹0' });
  server['GET /member/billing/plans'] = () => ({
    onlinePayment: true, mode: 'purchase', unavailableReason: null, previousProductId: null,
    plans: [
      { productId: 'prd_month', name: 'Depot Monthly', description: '', kind: 'membership', durationDays: 30, priceLabel: '₹2,500', taxLabel: '₹450', totalMinor: 295000, totalLabel: '₹2,950', cancellation: '', freezeAllowed: true },
      { productId: 'prd_quarter', name: 'Depot Quarterly', description: '', kind: 'membership', durationDays: 90, priceLabel: '₹6,500', taxLabel: '₹1,170', totalMinor: 767000, totalLabel: '₹7,670', cancellation: '', freezeAllowed: true },
    ],
  });
  try {
    renderBilling();
    const dialog = await screen.findByRole('dialog', { name: 'Choose a plan' });
    expect(await within(dialog).findByRole('radio', { name: /Depot Quarterly/ })).toBeChecked();
    expect(dialog).toHaveTextContent('Total today₹7,670');
    expect(api.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(window.location.search).toBe('');
  } finally {
    window.history.replaceState(null, '', '/');
  }
});

it('the plan sheet closes on Escape and keeps focus inside while open', async () => {
  server['GET /member/billing'] = () => billing({ membership: { ...billing().membership, state: 'expired' } });
  server['GET /member/billing/plans'] = () => ({ onlinePayment: true, mode: 'renew', unavailableReason: null, previousProductId: 'prd_month', plans: [
    { productId: 'prd_month', name: 'Depot Monthly', description: '', kind: 'membership', durationDays: 30, priceLabel: '₹2,500', taxLabel: '₹450', totalMinor: 295000, totalLabel: '₹2,950', cancellation: '', freezeAllowed: true },
  ] });
  renderBilling();
  const renew = await screen.findByRole('button', { name: 'Renew' });
  renew.focus();
  fireEvent.click(renew);
  const dialog = await screen.findByRole('dialog', { name: 'Renew your plan' });
  await within(dialog).findByRole('radio', { name: /Depot Monthly/ });
  expect(within(dialog).getByRole('radio', { name: /Depot Monthly/ })).toBeChecked();
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(renew).toHaveFocus();
});

it('without a provider keeps reception instructions and never loads Checkout', async () => {
  server['GET /member/billing'] = () => billing({ onlinePayment: { available: false, provider: null, testMode: false } });
  renderBilling();
  expect(await screen.findByText('Pay ₹295 at reception. Online payment is unavailable.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Pay|Choose a plan|Renew/ })).not.toBeInTheDocument();
  expect(screen.queryByText('Test mode')).not.toBeInTheDocument();
  expect(document.head.querySelector(`script[src="${CHECKOUT_SCRIPT_URL}"]`)).toBeNull();
});
