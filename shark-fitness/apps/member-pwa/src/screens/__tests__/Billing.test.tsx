import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../../lib/store', () => ({ useCopy: () => (key: string) => key }));
vi.mock('../../lib/api', () => ({ API_ORIGIN: '', api: vi.fn(async () => ({
  outstandingMinor: 10000, outstandingLabel: '₹100.00',
  membership: { id: 'membership', productName: 'Monthly', state: 'pending_payment', endsOn: null, autoRenew: false, priceLabel: '₹100.00' },
  invoices: [{ id: 'invoice', number: 'TEST-1', state: 'open', issuedOn: '2026-09-23', dueOn: '2026-09-30', totalLabel: '₹100.00', dueMinor: 10000, dueLabel: '₹100.00', payable: true }],
})) }));

import Billing from '../Billing';
import { api } from '../../lib/api';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('explains reception settlement for unpaid invoices without offering simulated collection', async () => {
  const client = new QueryClient();
  render(<QueryClientProvider client={client}><Billing /></QueryClientProvider>);
  expect(await screen.findByText('Pay ₹100.00 at reception. Online payment is unavailable.')).toBeInTheDocument();
  expect(screen.getByText(/activates after staff record the full payment/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /pay|checkout/i })).not.toBeInTheDocument();
  expect(vi.mocked(api).mock.calls).toEqual([['/member/billing']]);
  // The member realtime client invalidates this key when reception records money.
  await act(() => client.invalidateQueries({ queryKey: ['billing'] }));
  expect(api).toHaveBeenCalledTimes(2);
});

it('offers canonical payment downloads and makes a credit discrepancy and expired history visible', () => {
  // P05: PT credits are now usable (a delivered session spends one), so the
  // old "PT consumption is unavailable" line is gone; the ledger warning and
  // expired history must still be shown plainly.
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(['billing'], {
    outstandingMinor: 0, outstandingLabel: '₹0', membership: null, invoices: [],
    receipts: [{ id: 'receipt-id', amountLabel: '₹100', method: 'cash', settledAt: '2026-09-23T10:00:00Z' }],
    credits: { balances: [{ kind: 'class', signedBalance: 0, usableUnits: 0, ledgerUnits: -1, consumptionAvailable: true, warning: '1 credit was used before a matching purchase was recorded. Reception can check the history.', nextExpiry: null, lots: [] },
      { kind: 'pt', signedBalance: 2, usableUnits: 2, ledgerUnits: 2, consumptionAvailable: true, warning: null, nextExpiry: { units: 2, on: '2026-12-01' }, lots: [] }],
      packs: [], offers: [], saleAvailable: false, saleUnavailableReason: 'No credit packs are on sale at this branch right now.',
      historyNotice: 'Every change to your credits is listed here.', entries: [{ id: 'old-grant', kind: 'class', delta: 10, reason: 'Class pack', refType: null, refId: null, expiresOn: '2026-01-01', expired: true, createdAt: '2025-01-01T00:00:00Z' }],
    },
  });
  render(<QueryClientProvider client={client}><Billing /></QueryClientProvider>);
  expect(screen.getByRole('link', { name: 'Download record' })).toHaveAttribute('href', '/v1/member/billing/payments/receipt-id/receipt');
  expect(screen.getByRole('link', { name: 'Print / PDF' })).toHaveAttribute('href', '/v1/member/billing/payments/receipt-id/receipt?format=html');
  expect(screen.getByRole('alert')).toHaveTextContent('Reception can check the history.');
  expect(screen.getByText('2 expire on 1 Dec 2026')).toBeInTheDocument();
  expect(screen.getByText('No credit packs are on sale at this branch right now.')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Credit history'));
  expect(screen.getByText('1 Jan 2025 · expired 1 Jan 2026')).toBeVisible();
  expect(api).not.toHaveBeenCalled();
});

it('links each invoice to its tax invoice, named for what it is', () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  const invoice = { state: 'paid', issuedOn: '2026-08-31', dueOn: '2026-09-07', totalLabel: '₹29,498.82', dueMinor: 0, dueLabel: '₹0', payable: false };
  client.setQueryData(['billing'], {
    outstandingMinor: 0, outstandingLabel: '₹0', membership: null,
    invoices: [
      { ...invoice, id: 'inv-gst', number: 'SF-2026-00001', document: { kind: 'gst_tax_invoice', title: 'Tax invoice' } },
      { ...invoice, id: 'inv-plain', number: 'SF-2026-00002', document: { kind: 'invoice', title: 'Invoice' } },
    ],
  });
  render(<QueryClientProvider client={client}><Billing /></QueryClientProvider>);
  // A plain invoice is never labelled a tax invoice: that claim is what a member files.
  expect(screen.getByText('Tax invoice')).toBeInTheDocument();
  expect(screen.getByText('Invoice')).toBeInTheDocument();
  const downloads = screen.getAllByRole('link', { name: 'Download' });
  expect(downloads.map((link) => link.getAttribute('href'))).toEqual([
    '/v1/member/billing/invoices/inv-gst/tax-invoice',
    '/v1/member/billing/invoices/inv-plain/tax-invoice',
  ]);
  expect(screen.getAllByRole('link', { name: 'Print / PDF' })[0]).toHaveAttribute('href', '/v1/member/billing/invoices/inv-gst/tax-invoice?format=html');
});
