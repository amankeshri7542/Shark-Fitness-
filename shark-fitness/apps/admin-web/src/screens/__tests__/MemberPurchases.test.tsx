import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
vi.mock('../../lib/store', () => ({ usePermission: () => true }));
vi.mock('../../lib/api', async (original) => ({ ...await original<typeof import('../../lib/api')>(), api: vi.fn() }));
import { api } from '../../lib/api';
import { MemberPurchases } from '../MemberPurchases';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('requires explicit date, terms and debt confirmation, and preserves an ambiguous renewal retry key', async () => {
  let attempts = 0;
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path === '/admin/billing/products') return { items: [] } as never;
    if (path.endsWith('/credits')) return { balances: [], entries: [], saleUnavailableReason: 'New credit sales unavailable until rules approved.' } as never;
    if (options?.method === 'POST') {
      attempts += 1;
      if (attempts === 1) throw new Error('Connection interrupted');
      return { membershipId: 'new-term', invoiceId: 'new-invoice' } as never;
    }
    return { quoteToken: 'a'.repeat(64), productId: 'monthly', productName: 'Desk monthly', startedOn: '2026-09-23', endsOn: '2026-10-23', totalLabel: '₹118', priceLabel: '₹100', taxLabel: '₹18', requiresApproval: false, consequence: 'Existing debt stays payable.',
      freeze: { allowed: false }, cancellation: { description: 'At reception', noticeDays: 7, commitmentMonths: 0 }, access: { allBranches: true, windowStartMin: null, visitsPerWeek: null }, debts: [{ invoiceId: 'old', number: 'OLD-1', dueLabel: '₹20' }],
    } as never;
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemberPurchases memberId="member" /></QueryClientProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Review renewal' }));
  expect(await screen.findByText('Desk monthly')).toBeInTheDocument();
  expect(screen.getByText('OLD-1: ₹20')).toBeInTheDocument();
  const confirm = screen.getByRole('button', { name: 'Confirm renewal' });
  expect(confirm).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed the dates/ }));
  fireEvent.click(confirm);
  expect(await screen.findByText('Connection interrupted')).toBeInTheDocument();
  fireEvent.click(confirm);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  const writes = vi.mocked(api).mock.calls.filter(([, options]) => options?.method === 'POST');
  expect(writes).toHaveLength(2);
  expect(writes[0]?.[1]?.idempotencyKey).toBe(writes[1]?.[1]?.idempotencyKey);
  expect(writes[0]?.[1]?.body).toMatchObject({ quoteToken: 'a'.repeat(64), productId: 'monthly' });
});

it('shows an unsupported-state API refusal without offering confirmation', async () => {
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === '/admin/billing/products') return { items: [] } as never;
    if (path.endsWith('/credits')) return { balances: [], entries: [], saleUnavailableReason: 'New credit sales unavailable until rules approved.' } as never;
    throw new Error('Renewal is unavailable while this membership is frozen.');
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemberPurchases memberId="member" /></QueryClientProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Review renewal' }));
  expect(await screen.findByText('Renewal is unavailable while this membership is frozen.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Confirm renewal' })).toBeDisabled();
  expect(vi.mocked(api).mock.calls.every(([, options]) => options?.method !== 'POST')).toBe(true);
});
