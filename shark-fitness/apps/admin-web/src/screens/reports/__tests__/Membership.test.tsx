import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import type { MembershipReport } from '@shark/contracts';

import Membership from '../Membership';
import { TZ, meta, renderPanel } from './harness';

function membership(overrides: Partial<MembershipReport> = {}): MembershipReport {
  return {
    meta: meta(),
    joins: { value: 48, previous: 40, changeBp: 2000 },
    cancellations: { value: 12, previous: 15, changeBp: -2000 },
    freezes: { value: 5, previous: 3, changeBp: 6667 },
    renewals: { value: 31, previous: 29, changeBp: 690 },
    activeAtEnd: 412,
    churnBp: 283,
    netChange: 36,
    ltvMinor: 1_850_000,
    series: [
      { date: '2026-08-01', joins: 20, cancellations: 4 },
      { date: '2026-08-02', joins: 28, cancellations: 8 },
    ],
    byProduct: [
      { productId: 'prd_elite', productName: 'Elite Annual', joins: 30, cancellations: 4, activeAtEnd: 280 },
      { productId: 'prd_flex', productName: 'Flex Monthly', joins: 18, cancellations: 8, activeAtEnd: 132 },
    ],
    ...overrides,
  };
}

describe('Membership', () => {
  it('shows the movement of the base and what a membership is worth', () => {
    renderPanel(<Membership data={membership()} timeZone={TZ} />);
    expect(screen.getByText('+36')).toBeInTheDocument();
    expect(screen.getByText('412 active now')).toBeInTheDocument();
    expect(screen.getByText('₹18,500.00')).toBeInTheDocument();
    // Fewer cancellations is the good direction, and it still reads as a fall.
    expect(screen.getByText('▼ 20.0% vs previous')).toBeInTheDocument();

    const product = screen.getByText('Flex Monthly').closest('tr')!;
    expect(within(product).getByText('132')).toBeInTheDocument();
    const churn = screen.getByText('Churn').closest('tr')!;
    expect(within(churn).getByText('2.8%')).toBeInTheDocument();
  });

  it('withholds the money figure from a role without report.financial instead of showing zero', () => {
    renderPanel(<Membership data={membership({ ltvMinor: null, meta: meta({ canSeeFinancial: false }) })} timeZone={TZ} />);
    expect(screen.getByText('Withheld')).toBeInTheDocument();
    expect(screen.getByText('Needs report.financial.')).toBeInTheDocument();
    expect(screen.queryByText('₹0.00')).not.toBeInTheDocument();
    // The counts are not money and stay visible.
    expect(screen.getByText('+36')).toBeInTheDocument();
  });

  it('says there are no products, and leaves churn absent rather than zero over an empty base', () => {
    renderPanel(
      <Membership
        data={membership({
          joins: { value: 0, previous: 0, changeBp: null },
          cancellations: { value: 0, previous: 0, changeBp: null },
          activeAtEnd: 0,
          netChange: 0,
          churnBp: null,
          series: [],
          byProduct: [],
        })}
        timeZone={TZ}
      />,
    );
    expect(screen.getByText('No products')).toBeInTheDocument();
    const churn = screen.getByText('Churn').closest('tr')!;
    expect(within(churn).queryByText('0.0%')).not.toBeInTheDocument();
    expect(within(churn).getAllByText('—')).toHaveLength(2);
  });

  it('shows a missing prior period as absent in the movement table', () => {
    renderPanel(
      <Membership
        data={membership({
          meta: meta({ comparison: null }),
          joins: { value: 48, previous: null, changeBp: null },
          cancellations: { value: 12, previous: null, changeBp: null },
          freezes: { value: 5, previous: null, changeBp: null },
          renewals: { value: 31, previous: null, changeBp: null },
        })}
        timeZone={TZ}
      />,
    );
    expect(screen.getByText('No prior period to compare')).toBeInTheDocument();
    const joins = within(screen.getByRole('region', { name: 'Movement' })).getByText('Joins').closest('tr')!;
    expect(within(joins).getByText('—')).toBeInTheDocument();
  });
});
