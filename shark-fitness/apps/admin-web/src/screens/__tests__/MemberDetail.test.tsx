import { expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ memberId: 'new-member' }),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock('../../lib/store', () => ({ usePermission: () => true, useAdmin: (select: (state: unknown) => unknown) => select({ viewer: { role: 'reception' }, branches: [] }) }));
vi.mock('../../ui/shell', () => ({ Page: ({ children, actions }: { children: ReactNode; actions: ReactNode }) => <main>{actions}{children}</main> }));
vi.mock('../../lib/api', async (importOriginal) => ({ ...await importOriginal<typeof import('../../lib/api')>(), api: vi.fn() }));
import { api } from '../../lib/api';
import MemberDetail from '../MemberDetail';

it('shows awaiting plan and pending payment honestly, and offers retry when the catalogue fails', async () => {
  const member = {
    member: { id: 'new-member', memberNo: 'SF-TEST', name: 'Synthetic Walkin', initials: 'SW', lifecycle: 'trial', joinedOn: '2026-09-23', lastVisitLabel: 'Never', branchName: 'Main', tags: [], riskReasons: [] },
    training: { activeAssignment: null }, level: { level: 1, name: 'Minnow', progressPct: 0 },
    membership: null, membershipHistory: [], billing: { outstandingLabel: '₹0', invoices: [] },
    credits: [], visits: [], workouts: [], bookings: [], audit: [],
  };
  vi.mocked(api).mockImplementation(async (path) => {
    if (path.endsWith('/credits')) return { balances: [], entries: [] } as never;
    if (path === '/admin/billing/products') throw new Error('offline');
    return member as never;
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemberDetail /></QueryClientProvider>);
  expect(await screen.findByText('awaiting plan')).toBeInTheDocument();
  expect(screen.queryByText('trial', { exact: true })).not.toBeInTheDocument();
  fireEvent.click(screen.getAllByRole('button', { name: /^Assign plan$/ })[0]!);
  expect(await screen.findByText('Could not load plans')).toBeInTheDocument();
  expect(screen.queryByText('No published products yet. Publish one from Plans first.')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
  act(() => { client.setQueryData(['member', 'new-member'], {
    ...member, membership: { id: 'membership', state: 'pending_payment', productName: 'Desk plan', startedOn: '2026-09-23', endsOn: '2026-10-23', priceLabel: '₹100', freezeDaysUsed: 0, freezeRules: { maxDaysPerTerm: 0 }, cancellation: { description: 'At reception' } },
  }); });
  expect(await screen.findByText('pending payment')).toBeInTheDocument();
});
