import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';

import Revenue from '../Revenue';
import { TZ, meta, renderPanel, revenue } from './harness';

/* ============================================================================
   Revenue.

   A report is read once and acted on for a month, so the failures worth
   guarding are the ones that look like facts: a withheld figure rendered as a
   zero, a total invented across two currencies, a comparison against a period
   that never existed.
   ========================================================================= */

describe('Revenue — money a role may not see is absent, not zero', () => {
  it('renders a permission state rather than a page of zeroes', () => {
    renderPanel(
      <Revenue
        data={revenue({
          meta: meta({ canSeeFinancial: false, restricted: ['totals'] }),
          totals: null,
          byCurrency: [],
          series: [],
          byBranch: [],
          byProduct: [],
          byMethod: [],
        })}
        timeZone={TZ}
      />,
    );

    // "Revenue this month: ₹0.00" is a falsehood a person escalates.
    expect(screen.queryByText('₹0.00')).not.toBeInTheDocument();
    expect(screen.getByText(/Revenue figures/)).toBeInTheDocument();
  });

  it('shows the figures to a role that holds report.financial', () => {
    renderPanel(<Revenue data={revenue()} timeZone={TZ} />);
    // Net appears in the strip and again in the branch table — one surface,
    // two readings of the same figure, which is the point of the table.
    expect(screen.getAllByText('₹4,800.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('₹5,000.00').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Revenue figures/)).not.toBeInTheDocument();
  });
});

describe('Revenue — a mixed-currency range states no single total', () => {
  it('says so, lists each currency, and names the currency of the trend', () => {
    renderPanel(
      <Revenue
        data={revenue({
          meta: meta({ restricted: ['totals:mixed-currency'] }),
          totals: null,
          mixedCurrency: true,
          seriesCurrency: 'INR',
          byCurrency: [
            { currency: 'INR', grossMinor: 500_000, netMinor: 480_000, refundedMinor: 20_000, discountMinor: 0, taxMinor: 18_000, invoices: 12 },
            { currency: 'AED', grossMinor: 50_000, netMinor: 50_000, refundedMinor: 0, discountMinor: 0, taxMinor: 0, invoices: 1 },
          ],
        })}
        timeZone={TZ}
      />,
    );

    expect(screen.getByText(/spans 2 currencies/)).toBeInTheDocument();
    // Each currency on its own, because adding rupees to dirhams gives a
    // number that is wrong in a way nobody can see.
    expect(screen.getByText('Net · INR')).toBeInTheDocument();
    expect(screen.getByText('Net · AED')).toBeInTheDocument();
    expect(screen.getByText(/Net revenue by day · INR/)).toBeInTheDocument();
  });
});

describe('Revenue — the context strip says what the figures are of', () => {
  it('states the period, the scope, the zone and the freshness', () => {
    renderPanel(<Revenue data={revenue()} timeZone={TZ} />);
    expect(screen.getByText('2026-08-01 → 2026-08-18')).toBeInTheDocument();
    expect(screen.getByText(/18 days · Asia\/Kolkata/)).toBeInTheDocument();
    expect(screen.getByText('Koramangala Depot only.')).toBeInTheDocument();
    // Freshness beside the figures, not in a footnote (PF-RPT-004).
    expect(screen.getByText(/Batch/)).toBeInTheDocument();
  });

  it('names the comparison window when there is one', () => {
    renderPanel(<Revenue data={revenue()} timeZone={TZ} />);
    expect(screen.getByText('vs 2026-07-14 → 2026-07-31')).toBeInTheDocument();
    expect(screen.getAllByText(/vs previous/).length).toBeGreaterThan(0);
  });

  it('says there is no prior period rather than showing a fall from zero', () => {
    renderPanel(
      <Revenue
        data={revenue({
          meta: meta({ comparison: null }),
          totals: {
            grossMinor: { value: 500_000, previous: null, changeBp: null },
            netMinor: { value: 480_000, previous: null, changeBp: null },
            refundedMinor: 20_000,
            discountMinor: 0,
            taxMinor: 18_000,
            invoices: { value: 12, previous: null, changeBp: null },
            arpuMinor: 40_000,
          },
        })}
        timeZone={TZ}
      />,
    );

    expect(screen.getByText('No prior period to compare')).toBeInTheDocument();
    expect(screen.getAllByText('No prior period').length).toBeGreaterThan(0);
    // No invented percentage anywhere on the surface.
    expect(screen.queryByText(/vs previous/)).not.toBeInTheDocument();
  });
});

describe('Revenue — the tables are the evidence', () => {
  it('puts money in a right-aligned numeric column', () => {
    renderPanel(<Revenue data={revenue()} timeZone={TZ} />);
    const branchRow = screen.getByText('Koramangala Depot').closest('tr')!;
    const cells = within(branchRow).getAllByRole('cell');
    // Figures line up under their heading and hold digit width.
    expect(cells[1]).toHaveAttribute('data-numeric');
    expect(cells[2]).toHaveAttribute('data-numeric');
  });

  it('says nothing was sold rather than showing an empty table', () => {
    renderPanel(
      <Revenue data={revenue({ byProduct: [], byMethod: [], byBranch: [] })} timeZone={TZ} />,
    );
    expect(screen.getByText('Nothing sold')).toBeInTheDocument();
    expect(screen.getByText('No payments')).toBeInTheDocument();
  });

  it('shows an average of nothing as absent rather than zero', () => {
    renderPanel(
      <Revenue
        data={revenue({
          totals: {
            grossMinor: { value: 0, previous: 0, changeBp: null },
            netMinor: { value: 0, previous: 0, changeBp: null },
            refundedMinor: 0,
            discountMinor: 0,
            taxMinor: 0,
            invoices: { value: 0, previous: 0, changeBp: null },
            arpuMinor: null,
          },
        })}
        timeZone={TZ}
      />,
    );
    expect(screen.getByText('nobody paid in range')).toBeInTheDocument();
  });
});
