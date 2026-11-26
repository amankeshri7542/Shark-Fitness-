import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, api: apiMock };
});

import BillingScreen from '../Billing';
import { refuse, renderScreen, signInAs } from '../../test/harness';

/* The Billing screen (PF-BILL). Fixtures follow the `/admin/billing/*`
   handlers in apps/api/src/routes/admin/billing.ts. The payment-link action
   and the reconciliation panel are covered in BillingPayments.test.tsx. */

const summary = {
  revenueThisMonthMinor: 1_250_000,
  revenueThisMonthLabel: '₹12,500',
  restricted: [],
  outstandingMinor: 295_000,
  outstandingLabel: '₹2,950',
  outstandingInvoiceCount: 1,
  overdueCount: 1,
  failedPaymentCount: 0,
};

const overdue = {
  id: 'inv_1',
  number: 'SF-2026-00042',
  state: 'overdue',
  issuedOn: '2026-11-01',
  dueOn: '2026-11-08',
  memberId: 'mbr_1',
  memberName: 'Aman Verma',
  memberNo: 'SF-1001',
  totalLabel: '₹2,950',
  dueMinor: 295_000,
  dueLabel: '₹2,950',
};

const paid = { ...overdue, id: 'inv_2', number: 'SF-2026-00041', state: 'paid', memberName: 'Asha Iyer', memberNo: 'SF-1002', dueMinor: 0, dueLabel: '₹0' };

const detail = {
  invoice: {
    id: 'inv_1',
    number: 'SF-2026-00042',
    state: 'overdue',
    issuedOn: '2026-11-01',
    dueOn: '2026-11-08',
    subtotalLabel: '₹2,500',
    taxLabel: '₹450',
    totalLabel: '₹2,950',
    paidLabel: '₹0',
    refundedLabel: '₹0',
    dueMinor: 295_000,
    dueLabel: '₹2,950',
    voided: false,
    voidReason: null,
    memberName: 'Aman Verma',
    memberNo: 'SF-1001',
    document: { kind: 'invoice', title: 'Invoice' },
  },
  lines: [{ id: 'ln_1', description: 'Monthly membership', quantity: 1, unitLabel: '₹2,500', taxLabel: '₹450', totalLabel: '₹2,950' }],
  payments: [],
  refunds: [],
  dunning: [],
};

type Handler = (options?: { method?: string; body?: unknown }) => unknown;

function routeApi(overrides: Record<string, Handler> = {}) {
  const routes: Record<string, Handler> = {
    '/admin/billing/summary': () => summary,
    '/admin/billing/invoices': () => ({ total: 2, items: [overdue, paid], hasMore: false }),
    '/admin/billing/dunning': () => ({ items: [] }),
    '/admin/billing/reconciliation': () => ({ onlinePayment: false, items: [] }),
    '/admin/billing/invoices/inv_1': () => detail,
    ...overrides,
  };
  apiMock.mockImplementation((path: string, options?: { method?: string; body?: unknown }) => {
    const handler = routes[path] ?? routes[path.split('?')[0]!];
    if (!handler) throw new Error(`Unexpected API call: ${path}`);
    return Promise.resolve().then(() => handler(options));
  });
}

const STATES = ['', 'outstanding', 'open', 'partially_paid', 'overdue', 'paid', 'void', 'partially_refunded', 'refunded'];
const screens = [
  {
    path: '/billing',
    component: BillingScreen,
    validateSearch: (s: Record<string, unknown>) => ({
      state: STATES.includes(s.state as string) ? (s.state as string) : undefined,
      ...(typeof s.invoice === 'string' ? { invoice: s.invoice } : {}),
      ...(s.pay === 1 || s.pay === '1' ? { pay: 1 } : {}),
    }),
  },
];

beforeEach(() => {
  apiMock.mockReset();
  signInAs('owner');
  routeApi();
});

describe('Billing', () => {
  it('shows a permission state, and reads nothing, for a role without billing', async () => {
    signInAs('trainer');
    renderScreen('/billing', screens);
    expect(await screen.findByText('Not available to your role')).toBeInTheDocument();
    expect(screen.getByText(/Billing and reconciliation is restricted/)).toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('shows a loading page until both the summary and the invoices arrive', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    apiMock.mockImplementation((path: string) =>
      path === '/admin/billing/summary' ? gate.then(() => summary) : Promise.resolve(path.startsWith('/admin/billing/invoices') ? { total: 0, items: [], hasMore: false } : { items: [] }),
    );
    renderScreen('/billing', screens);
    expect(await screen.findByText('Loading')).toBeInTheDocument();
    expect(screen.queryByText('No invoices')).toBeNull();
    release();
    expect(await screen.findByRole('heading', { name: 'No invoices' })).toBeInTheDocument();
  });

  it('says billing could not load, and retries', async () => {
    const user = userEvent.setup();
    routeApi({ '/admin/billing/invoices': () => refuse(new Error('down')) });
    renderScreen('/billing', screens);
    expect(await screen.findByRole('heading', { name: 'Could not load billing' })).toBeInTheDocument();
    routeApi();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'SF-2026-00042' })).toBeInTheDocument();
  });

  it('says there are no invoices rather than drawing an empty table', async () => {
    routeApi({ '/admin/billing/invoices': () => ({ total: 0, items: [], hasMore: false }) });
    renderScreen('/billing', screens);
    expect(await screen.findByRole('heading', { name: 'No invoices' })).toBeInTheDocument();
    expect(screen.getByText('0 invoices')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows the money, the dunning queue and every invoice', async () => {
    routeApi({
      '/admin/billing/dunning': () => ({
        items: [{ invoiceId: 'inv_1', number: 'SF-2026-00042', memberName: 'Aman Verma', dueLabel: '₹2,950', attempts: [{ attempt: 2, channel: 'in_app', state: 'sent' }] }],
      }),
    });
    renderScreen('/billing', screens);
    const table = await screen.findByRole('table');
    expect(screen.getByText('2 invoices')).toBeInTheDocument();
    expect(screen.getByText('₹12,500')).toBeInTheDocument();
    const queue = await screen.findByRole('region', { name: 'Dunning queue · 1' });
    expect(within(queue).getByText('₹2,950 · attempt 2 (sent)')).toBeInTheDocument();

    const [, first, second] = within(table).getAllByRole('row');
    expect(within(first!).getByText('overdue')).toBeInTheDocument();
    expect(within(first!).getByText(/Aman Verma/)).toBeInTheDocument();
    expect(within(second!).getByText('paid')).toBeInTheDocument();
  });

  it('withholds revenue from a role without financial reports, rather than showing zero', async () => {
    signInAs('reception');
    routeApi({ '/admin/billing/summary': () => ({ ...summary, revenueThisMonthMinor: null, revenueThisMonthLabel: null, restricted: ['revenueThisMonth'] }) });
    renderScreen('/billing', screens);
    expect(await screen.findByText('Owner and accounts only')).toBeInTheDocument();
    expect(screen.queryByText('₹12,500')).toBeNull();
  });

  it('warns when the list is cut short', async () => {
    routeApi({ '/admin/billing/invoices': () => ({ total: 340, items: [overdue, paid], hasMore: true }) });
    renderScreen('/billing', screens);
    expect(await screen.findByText('Showing 2 of 340 invoices. Filter by state to narrow the list.')).toBeInTheDocument();
  });

  it('filters by state and keeps the filter in the URL', async () => {
    const user = userEvent.setup();
    const { router } = renderScreen('/billing', screens);
    await screen.findByRole('table');
    expect(screen.getByRole('button', { name: 'all' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'overdue' }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ state: 'overdue' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/admin/billing/invoices?state=overdue'));
    expect(screen.getByRole('button', { name: 'overdue' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('opens an invoice and records a verified cash payment', async () => {
    const user = userEvent.setup();
    routeApi({ '/admin/billing/invoices/inv_1/payments': () => ({ payment: { id: 'pay_1' } }) });
    renderScreen('/billing', screens);
    await user.click(await screen.findByRole('button', { name: 'SF-2026-00042' }));
    const drawer = await screen.findByRole('dialog', { name: 'SF-2026-00042' });
    expect(within(drawer).getByText('Monthly membership')).toBeInTheDocument();
    expect(within(drawer).getByText('No payment attempts yet.')).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Void' })).toBeInTheDocument();

    await user.click(within(drawer).getByRole('button', { name: 'Record payment' }));
    const sheet = await screen.findByRole('dialog', { name: 'Record payment' });
    await user.type(within(sheet).getByLabelText('Amount (₹)'), '2950');
    const record = within(sheet).getByRole('button', { name: 'Record payment' });
    expect(record).toBeDisabled();
    await user.click(within(sheet).getByLabelText('I independently verified that these funds have been received.'));
    await user.click(record);
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/admin/billing/invoices/inv_1/payments', {
        method: 'POST',
        body: { amountMinor: 295_000, method: 'cash', reference: undefined, idempotencyKey: expect.any(String) },
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Record payment' })).toBeNull());
  });

  it('says an invoice could not be read inside its drawer, and retries', async () => {
    const user = userEvent.setup();
    routeApi({ '/admin/billing/invoices/inv_1': () => refuse(new Error('down')) });
    renderScreen('/billing?invoice=inv_1', screens);
    const drawer = await screen.findByRole('dialog', { name: 'Invoice' });
    expect(await within(drawer).findByRole('heading', { name: 'Could not load this invoice' })).toBeInTheDocument();
    routeApi();
    await user.click(within(drawer).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('dialog', { name: 'SF-2026-00042' })).toBeInTheDocument();
  });

  it('opens straight onto Record payment from a pay link, without Void for a role that cannot write off', async () => {
    signInAs('regional_manager');
    renderScreen('/billing?invoice=inv_1&pay=1', screens);
    expect(await screen.findByRole('dialog', { name: 'Record payment' })).toBeInTheDocument();
    const drawer = screen.getByRole('dialog', { name: 'SF-2026-00042' });
    expect(within(drawer).queryByRole('button', { name: 'Void' })).toBeNull();
  });
});
