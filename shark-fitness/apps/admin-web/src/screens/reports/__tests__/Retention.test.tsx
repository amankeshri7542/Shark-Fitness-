import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import type { RetentionReport } from '@shark/contracts';

import Retention from '../Retention';
import { TZ, meta, renderPanel } from './harness';

function retention(overrides: Partial<RetentionReport> = {}): RetentionReport {
  return {
    meta: meta({ freshness: 'near_realtime' }),
    bands: { high: 14, watch: 37, low: 361 },
    cohorts: [
      { cohort: '2026-06', joined: 52, stillActive: 47, retainedBp: 9038 },
      { cohort: '2026-07', joined: 61, stillActive: 60, retainedBp: 9836 },
    ],
    atRiskValueMinor: 4_200_000,
    ...overrides,
  };
}

describe('Retention', () => {
  it('bands members by risk and prices the high-risk memberships', () => {
    renderPanel(<Retention data={retention()} timeZone={TZ} />);
    expect(screen.getByText('14')).toBeInTheDocument();
    expect(screen.getByText('of 412 members')).toBeInTheDocument();
    expect(screen.getByText('₹42,000.00')).toBeInTheDocument();
    expect(screen.getByText(/Near real-time/)).toBeInTheDocument();
  });

  it('lists each joining month with how much of it is still here', () => {
    renderPanel(<Retention data={retention()} timeZone={TZ} />);
    const cohorts = screen.getByRole('region', { name: 'Cohorts by joining month' });
    const june = within(cohorts).getByText('2026-06').closest('tr')!;
    expect(within(june).getByText('47')).toBeInTheDocument();
    expect(within(june).getByText('90.4%')).toBeInTheDocument();
  });

  it('withholds the value at risk from a role without report.financial', () => {
    renderPanel(<Retention data={retention({ atRiskValueMinor: null, meta: meta({ canSeeFinancial: false }) })} timeZone={TZ} />);
    expect(screen.getByText('Withheld')).toBeInTheDocument();
    expect(screen.getByText('Needs report.financial.')).toBeInTheDocument();
    expect(screen.queryByText('₹0.00')).not.toBeInTheDocument();
  });

  it('says there are no cohorts rather than an empty table, and leaves a cohort of nobody absent', () => {
    const { unmount } = renderPanel(<Retention data={retention({ bands: { high: 0, watch: 0, low: 0 }, cohorts: [] })} timeZone={TZ} />);
    expect(screen.getByText('No cohorts')).toBeInTheDocument();
    expect(screen.getByText('of 0 members')).toBeInTheDocument();
    unmount();

    renderPanel(<Retention data={retention({ cohorts: [{ cohort: '2026-08', joined: 0, stillActive: 0, retainedBp: null }] })} timeZone={TZ} />);
    const row = screen.getByText('2026-08').closest('tr')!;
    expect(within(row).getByText('—')).toBeInTheDocument();
    expect(within(row).queryByText('0.0%')).not.toBeInTheDocument();
  });
});
