import type { ReactElement } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BranchDetail, ResolvedSetting } from '@shark/contracts';

export function renderPanel(element: ReactElement): RenderResult {
  const client = new QueryClient({
    mutationCache: new MutationCache({ onError: () => undefined }),
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

export function setting(overrides: Partial<ResolvedSetting> = {}): ResolvedSetting {
  return {
    key: 'antiPassbackSeconds',
    label: 'Anti-passback window',
    help: 'Seconds before the same member may scan in again.',
    kind: 'number',
    value: 90,
    source: 'tenant',
    tenantValue: 90,
    overridable: true,
    ...overrides,
  };
}

export function branch(overrides: Partial<BranchDetail> = {}): BranchDetail {
  return {
    id: 'br_kor',
    name: 'Koramangala Depot',
    slug: 'koramangala',
    addressLine: '80 Feet Road, 5th Block',
    city: 'Bengaluru',
    timezone: 'Asia/Kolkata',
    capacity: 120,
    opensAt: '05:00',
    closesAt: '23:00',
    hours: null,
    holidays: [],
    amenities: [],
    phone: '+91 80 4000 1000',
    email: 'koramangala@sharkfitness.in',
    state: 'active',
    stateMeaning: 'Open and trading.',
    trades: true,
    stateChangedAt: '2024-03-06T00:00:00.000Z',
    stateNote: 'Opened',
    nextStates: ['temporarily_closed', 'suspended', 'archived'],
    rooms: [{ id: 'rom_1', name: 'Studio 1', capacity: 24 }],
    settings: [setting()],
    counts: { members: 23, grantedMembers: 2, futureBookings: 1532, staff: 7 , openTickets: 3 },
    ...overrides,
  };
}
