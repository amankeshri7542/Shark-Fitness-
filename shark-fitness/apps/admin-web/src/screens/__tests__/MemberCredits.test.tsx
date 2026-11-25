import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CreditAccount, CreditPackView } from '@shark/contracts';

const permissions = vi.hoisted(() => ({ granted: new Set<string>(['billing.record_payment', 'billing.refund', 'member.edit']) }));
vi.mock('../../lib/store', () => ({ usePermission: (permission: string) => permissions.granted.has(permission) }));
vi.mock('../../lib/api', async (original) => ({ ...(await original<typeof import('../../lib/api')>()), api: vi.fn() }));

import { ApiError, api } from '../../lib/api';
import { MemberCredits } from '../members/MemberCredits';

afterEach(() => {
  cleanup();
  vi.mocked(api).mockReset();
  permissions.granted = new Set(['billing.record_payment', 'billing.refund', 'member.edit']);
});

const activePack: CreditPackView = {
  id: 'cpk_1', productId: 'prd_class_10', productName: 'Class Pack — 10', kind: 'class', units: 10, state: 'active', priceMinor: 599_900, priceLabel: '₹5,999',
  invoiceId: 'inv_1', invoiceNumber: 'SF-2026-00010', invoiceState: 'paid', dueMinor: 0, soldBy: 'staff', createdAt: '2026-11-01T10:00:00Z', allocatedAt: '2026-11-01T10:05:00Z',
  expiresOn: '2027-04-30', remaining: 7, used: 3, expired: false,
  refund: { refundable: true, kind: 'partial', units: 7, amountMinor: 419_930, amountLabel: '₹4,199.30', message: '3 of 10 credits are used or gone. The 7 unused credits are refunded at the pack’s unit price and removed.' },
};

function account(overrides: Partial<CreditAccount> = {}): CreditAccount {
  return {
    today: '2026-11-25',
    balances: [
      { kind: 'class', signedBalance: 7, usableUnits: 7, ledgerUnits: 7, consumptionAvailable: true, warning: null, nextExpiry: { units: 7, on: '2027-04-30' }, lots: [] },
      { kind: 'pt', signedBalance: 2, usableUnits: 2, ledgerUnits: 2, consumptionAvailable: true, warning: null, nextExpiry: { units: 2, on: '2026-12-31' }, lots: [] },
    ],
    entries: [{ id: 'crd_1', kind: 'class', delta: 10, reason: 'Purchased Class Pack — 10', refType: 'credit_pack', refId: 'cpk_1', expiresOn: '2027-04-30', expired: false, createdAt: '2026-11-01T10:05:00Z' }],
    packs: [activePack],
    offers: [{ productId: 'prd_class_10', name: 'Class Pack — 10', description: '', kind: 'class', units: 10, validDays: 180, totalMinor: 707_882, totalLabel: '₹7,078.82', perCreditLabel: '₹707.88' }],
    saleAvailable: true,
    saleUnavailableReason: '',
    historyNotice: 'Every change to your credits is listed here.',
    ...overrides,
  };
}

function renderCredits(data: CreditAccount | Error = account(), onPost?: (path: string, body: unknown) => unknown) {
  vi.mocked(api).mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
    if (options?.method === 'POST') return (onPost?.(path, options.body) ?? { message: 'Done.' }) as never;
    if (data instanceof Error) throw data;
    return data as never;
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <MemberCredits memberId="mbr_1" />
    </QueryClientProvider>,
  );
}

it('shows balances, packs and the ledger', async () => {
  renderCredits();
  expect(await screen.findByText('Class Pack — 10')).toBeInTheDocument();
  expect(screen.getByText('7 expire 2027-04-30')).toBeInTheDocument();
  expect(screen.getByText(/7\/10 left · expires 2027-04-30/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Show ledger' }));
  expect(screen.getByText('Class · Purchased Class Pack — 10')).toBeInTheDocument();
});

it('loading, error and empty states', async () => {
  renderCredits(new ApiError(500, { error: { code: 'INTERNAL', message: 'The ledger could not be read.', requestId: 'r' } }));
  expect(await screen.findByText('Could not load credits')).toBeInTheDocument();
  cleanup();
  renderCredits(account({ packs: [] }));
  expect(await screen.findByText('No packs yet')).toBeInTheDocument();
});

it('a partial refund states the amount and the rule, and needs a reason', async () => {
  renderCredits(account(), () => ({ message: '7 credits were removed. Pay ₹4,199.30 back to the member the way they paid (cash).' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Refund Class Pack — 10' }));
  const dialog = await screen.findByRole('dialog', { name: 'Refund Class Pack — 10' });
  expect(dialog).toHaveTextContent('The 7 unused credits are refunded');
  const confirm = screen.getByRole('button', { name: 'Refund ₹4,199.30' });
  expect(confirm).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Moving to Pune' } });
  fireEvent.click(confirm);
  expect(await screen.findByText(/Pay ₹4,199.30 back to the member/)).toBeInTheDocument();
  const write = vi.mocked(api).mock.calls.find(([, options]) => options?.method === 'POST')!;
  expect(write[0]).toBe('/admin/billing/credit-packs/cpk_1/refund');
  expect(write[1]).toMatchObject({ body: { reason: 'Moving to Pune' }, idempotencyKey: expect.any(String) });
});

it('an expired pack explains why nothing can be refunded and offers no button', async () => {
  const expired = { ...activePack, expired: true, refund: { refundable: false, kind: null, units: 0, amountMinor: 0, amountLabel: '₹0', message: 'These credits have expired. Expired credits are not refundable.' } } as CreditPackView;
  renderCredits(account({ packs: [expired] }));
  fireEvent.click(await screen.findByRole('button', { name: 'Refund Class Pack — 10' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Expired credits are not refundable.');
  expect(screen.queryByRole('button', { name: /^Refund ₹/ })).not.toBeInTheDocument();
});

it('selling raises an invoice and says when the credits arrive', async () => {
  renderCredits(account(), () => ({ message: 'Invoice raised. The credits appear as soon as it is paid in full.' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Sell a pack' }));
  const dialog = await screen.findByRole('dialog', { name: 'Sell a credit pack' });
  expect(dialog).toHaveTextContent('the credits are added the moment it is paid in full');
  fireEvent.click(screen.getByRole('button', { name: 'Raise invoice · ₹7,078.82' }));
  expect(await screen.findByText('Invoice raised. The credits appear as soon as it is paid in full.')).toBeInTheDocument();
});

it('records a PT session only when a PT credit is there to use', async () => {
  renderCredits(account(), () => ({ replayed: false }));
  fireEvent.click(await screen.findByRole('button', { name: 'Record a PT session' }));
  expect(await screen.findByText(/One PT credit was used/)).toBeInTheDocument();
  cleanup();
  renderCredits(account({ balances: account().balances.map((b) => (b.kind === 'pt' ? { ...b, usableUnits: 0, nextExpiry: null } : b)) }));
  expect(await screen.findByRole('button', { name: 'Record a PT session' })).toBeDisabled();
});

it('without billing permissions: no sell or refund actions, the record is still readable', async () => {
  permissions.granted = new Set();
  renderCredits();
  expect(await screen.findByText('Class Pack — 10')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Sell a pack' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Refund/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Record a PT session' })).not.toBeInTheDocument();
});
