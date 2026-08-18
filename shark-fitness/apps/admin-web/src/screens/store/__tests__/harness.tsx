import type { ReactElement } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PosOrderSummary, StockTransfer, StoreProduct } from '@shark/contracts';

/** Renders a Store panel with a throwaway query client, retries off. */
export function renderPanel(element: ReactElement): RenderResult {
  const client = new QueryClient({
    // Components handle their own mutation errors and show them in the UI. The
    // cache-level handler exists so a deliberately-rejected mock does not reach
    // Vitest's unhandled-rejection guard and fail the run around a passing test.
    mutationCache: new MutationCache({ onError: () => undefined }),
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

/** ₹1,000.00 at 18% tax — one unit costs ₹1,180.00 at the till. */
export function product(overrides: Partial<StoreProduct> = {}): StoreProduct {
  return {
    id: 'rtl_tee',
    name: 'Shark Tee',
    displayName: 'Shark Tee — M',
    sku: 'TEE-M',
    barcode: '8901234567890',
    category: 'Apparel',
    variantName: 'M',
    groupId: null,
    groupName: null,
    supplierId: null,
    supplierName: 'Coastal Apparel',
    priceMinor: 100_000,
    taxRateBp: 1800,
    reorderAt: 5,
    active: true,
    onHand: 12,
    lowStock: false,
    costMinor: 40_000,
    valuationMinor: 480_000,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

export function order(overrides: Partial<PosOrderSummary> = {}): PosOrderSummary {
  return {
    id: 'pos_1',
    reference: 'SF-20260818-AB12C',
    branchId: 'br_kor',
    branchName: 'Koramangala',
    memberId: null,
    memberName: null,
    kind: 'sale',
    state: 'paid',
    subtotalMinor: 100_000,
    discountMinor: 0,
    taxMinor: 18_000,
    totalMinor: 118_000,
    staffId: 'stf_1',
    staffName: 'Deepa Kumar',
    invoiceId: null,
    returnOfOrderId: null,
    voidReason: null,
    voidedAt: null,
    createdAt: '2026-08-18T09:30:00.000Z',
    ...overrides,
  };
}

export function transfer(overrides: Partial<StockTransfer> = {}): StockTransfer {
  return {
    id: 'trf_1',
    reference: 'TR-ABC123',
    fromBranchId: 'br_kor',
    fromBranchName: 'Koramangala',
    toBranchId: 'br_hsr',
    toBranchName: 'HSR Layout',
    state: 'draft',
    note: null,
    createdBy: 'Sunita Rao',
    dispatchedAt: null,
    dispatchedBy: null,
    receivedAt: null,
    receivedBy: null,
    cancelledAt: null,
    createdAt: '2026-08-18T08:00:00.000Z',
    unitsInTransit: 0,
    ...overrides,
  };
}

export const allowAll = { canSeeMargin: true, canSeeCost: true, restricted: [] };
export const noFinancials = {
  canSeeMargin: false,
  canSeeCost: false,
  restricted: ['costMinor', 'unitCostMinor', 'marginMinor', 'valuationMinor', 'shrinkageCostMinor'],
};
