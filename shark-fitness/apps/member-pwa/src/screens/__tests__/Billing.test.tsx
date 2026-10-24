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

it('offers canonical payment downloads and makes expiry discrepancies and unavailable PT use visible', () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(['billing'], {
    outstandingMinor: 0, outstandingLabel: '₹0', membership: null, invoices: [],
    receipts: [{ id: 'receipt-id', amountLabel: '₹100', method: 'cash', settledAt: '2026-09-23T10:00:00Z' }],
    credits: { balances: [{ kind: 'class', signedBalance: -1, usableUnits: 0, consumptionAvailable: true, warning: 'Reconcile' }, { kind: 'pt', signedBalance: 2, usableUnits: null, consumptionAvailable: false }],
      historyNotice: 'Earlier grants may lack purchased terms.', entries: [{ id: 'old-grant', kind: 'class', delta: 10, reason: 'Class pack', expiresOn: '2026-01-01', expired: true, createdAt: '2025-01-01T00:00:00Z' }],
    },
  });
  render(<QueryClientProvider client={client}><Billing /></QueryClientProvider>);
  expect(screen.getByRole('link', { name: 'Download record' })).toHaveAttribute('href', '/v1/member/billing/payments/receipt-id/receipt');
  expect(screen.getByRole('link', { name: 'Print / PDF' })).toHaveAttribute('href', '/v1/member/billing/payments/receipt-id/receipt?format=html');
  expect(screen.getByText('PT consumption is unavailable.')).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('No adjustment has been made.');
  fireEvent.click(screen.getByText('Credit history'));
  expect(screen.getByText('2025-01-01 · Expired 2026-01-01')).toBeVisible();
  expect(api).not.toHaveBeenCalled();
});
