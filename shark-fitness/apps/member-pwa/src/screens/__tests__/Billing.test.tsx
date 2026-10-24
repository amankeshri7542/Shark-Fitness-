import { expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../../lib/store', () => ({ useCopy: () => (key: string) => key }));
vi.mock('../../lib/api', () => ({ api: vi.fn(async () => ({
  outstandingMinor: 10000, outstandingLabel: '₹100.00',
  membership: { id: 'membership', productName: 'Monthly', state: 'pending_payment', endsOn: null, autoRenew: false, priceLabel: '₹100.00' },
  invoices: [{ id: 'invoice', number: 'TEST-1', state: 'open', issuedOn: '2026-09-23', dueOn: '2026-09-30', totalLabel: '₹100.00', dueMinor: 10000, dueLabel: '₹100.00', payable: true }],
})) }));

import Billing from '../Billing';
import { api } from '../../lib/api';

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
