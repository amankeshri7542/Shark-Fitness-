import type { ReactElement } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReportMeta, RevenueReport } from '@shark/contracts';

export function renderPanel(element: ReactElement): RenderResult {
  const client = new QueryClient({
    mutationCache: new MutationCache({ onError: () => undefined }),
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

export const TZ = 'Asia/Kolkata';

export function meta(overrides: Partial<ReportMeta> = {}): ReportMeta {
  return {
    period: { from: '2026-08-01', to: '2026-08-18', days: 18, label: '2026-08-01 to 2026-08-18' },
    comparison: { from: '2026-07-14', to: '2026-07-31', days: 18, label: '2026-07-14 to 2026-07-31' },
    timeZone: TZ,
    branchIds: ['br_kor'],
    scopeNote: 'Koramangala Depot only.',
    freshness: 'batch',
    computedAt: '2026-08-19T04:00:00.000Z',
    restricted: [],
    canSeeFinancial: true,
    canExport: true,
    ...overrides,
  };
}

export function revenue(overrides: Partial<RevenueReport> = {}): RevenueReport {
  return {
    meta: meta(),
    totals: {
      grossMinor: { value: 500_000, previous: 400_000, changeBp: 2500 },
      netMinor: { value: 480_000, previous: 400_000, changeBp: 2000 },
      refundedMinor: 20_000,
      discountMinor: 0,
      taxMinor: 18_000,
      invoices: { value: 12, previous: 10, changeBp: 2000 },
      arpuMinor: 40_000,
    },
    byCurrency: [
      { currency: 'INR', grossMinor: 500_000, netMinor: 480_000, refundedMinor: 20_000, discountMinor: 0, taxMinor: 18_000, invoices: 12 },
    ],
    mixedCurrency: false,
    seriesCurrency: 'INR',
    series: [
      { date: '2026-08-01', netMinor: 240_000, grossMinor: 250_000, refundedMinor: 10_000, invoices: 6 },
      { date: '2026-08-02', netMinor: 240_000, grossMinor: 250_000, refundedMinor: 10_000, invoices: 6 },
    ],
    byBranch: [{ branchId: 'br_kor', branchName: 'Koramangala Depot', netMinor: 480_000, invoices: 12 }],
    byProduct: [{ productId: null, productName: 'Elite Annual', netMinor: 480_000, count: 12 }],
    byMethod: [{ method: 'cash', amountMinor: 480_000, payments: 12 }],
    ...overrides,
  };
}
