import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import type { StoreReport } from '@shark/contracts';

import Insights from '../Insights';
import { allowAll, noFinancials, renderPanel } from './harness';

function report(overrides: Partial<StoreReport> = {}): StoreReport {
  return {
    scope: { branchId: 'br_kor', branches: 1, from: '2026-07-19T00:00:00.000Z', to: '2026-08-18T00:00:00.000Z' },
    sales: { orders: 42, returns: 3, voided: 1, unitsSold: 88, revenueMinor: 1_200_000, taxMinor: 216_000 },
    margin: { revenueMinor: 1_200_000, costMinor: 500_000, marginMinor: 700_000, marginBp: 5833 },
    valuation: { valuationMinor: 3_400_000, skus: 24 },
    shrinkage: { units: 4, costMinor: 16_000 },
    lowStock: [{ id: 'rtl_2', name: 'Shaker', sku: 'SHK', onHand: 2, reorderAt: 5 }],
    topProducts: [{ productId: 'rtl_tee', name: 'Shark Tee — M', units: 30, revenueMinor: 300_000, marginMinor: 180_000 }],
    asOf: '2026-08-18T12:00:00.000Z',
    financial: allowAll,
    ...overrides,
  };
}

/** The report withheld of everything `report.financial` gates. */
const restricted = report({
  margin: null,
  valuation: null,
  shrinkage: { units: 4, costMinor: null },
  topProducts: [{ productId: 'rtl_tee', name: 'Shark Tee — M', units: 30, revenueMinor: 300_000, marginMinor: null }],
  financial: noFinancials,
});

function open(value: StoreReport) {
  return renderPanel(<Insights report={value} loading={false} window="30" onWindow={() => undefined} />);
}

describe('Insights — with financial access', () => {
  it('shows margin, stock value and shrinkage cost', () => {
    open(report());

    // Margin appears twice by design — once in the headline, once in the
    // margin breakdown — so assert on both rather than either.
    expect(screen.getAllByText('₹7,000.00')).toHaveLength(2);
    expect(screen.getByText('₹34,000.00')).toBeInTheDocument(); // stock value
    expect(screen.getByText('₹160.00')).toBeInTheDocument(); // shrinkage cost
    expect(screen.getAllByText('58.3%').length).toBeGreaterThan(0); // margin rate
  });

  it('says margin is priced at the cost captured when it sold', () => {
    open(report());
    expect(screen.getByText(/not the product's cost today/)).toBeInTheDocument();
  });

  it('states how fresh the figures are', () => {
    open(report());
    expect(screen.getByText(/Live/)).toBeInTheDocument();
  });
});

describe('Insights — without financial access', () => {
  it('withholds every commercial figure rather than showing a zero', () => {
    open(restricted);

    // ₹0.00 would read as a real and very different fact about the shop.
    expect(screen.queryByText('₹0.00')).not.toBeInTheDocument();
    expect(screen.getAllByText('Restricted').length).toBeGreaterThanOrEqual(3);
  });

  it('explains the denial instead of rendering an empty margin panel', () => {
    open(restricted);

    expect(screen.getByText('Not available to your role')).toBeInTheDocument();
    expect(screen.getByText(/need financial reporting access/)).toBeInTheDocument();
  });

  it('still shows the operating figures the shop runs on', () => {
    open(restricted);

    // Takings, units and what to reorder are the job, not the commercials.
    expect(screen.getByText('₹12,000.00')).toBeInTheDocument();
    expect(screen.getByText('88 units')).toBeInTheDocument();
    expect(screen.getByText(/4 units/)).toBeInTheDocument(); // shrinkage units survives the gate
    expect(screen.getByText('Shaker')).toBeInTheDocument();
    expect(screen.getByText('Needs reordering · 1')).toBeInTheDocument();
  });

  it('keeps takings per product but withholds the margin column', () => {
    open(restricted);

    expect(screen.getByText('₹3,000.00')).toBeInTheDocument(); // top-seller revenue
    expect(screen.queryByText('₹1,800.00')).not.toBeInTheDocument(); // its margin
  });
});
