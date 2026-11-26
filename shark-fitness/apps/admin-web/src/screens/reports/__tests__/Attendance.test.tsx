import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import type { AttendanceReport } from '@shark/contracts';

import Attendance from '../Attendance';
import { TZ, meta, renderPanel } from './harness';

const hours = (busy: Record<number, number> = {}) => Array.from({ length: 24 }, (_unused, hour) => ({ hour, visits: busy[hour] ?? 0 }));

function attendance(overrides: Partial<AttendanceReport> = {}): AttendanceReport {
  return {
    meta: meta(),
    visits: { value: 1240, previous: 1000, changeBp: 2400 },
    uniqueMembers: { value: 310, previous: 300, changeBp: 333 },
    noShows: { value: 42, previous: 30, changeBp: 4000 },
    noShowRateBp: 650,
    occupancyBp: 7125,
    series: [
      { date: '2026-08-01', visits: 640, noShows: 20 },
      { date: '2026-08-02', visits: 600, noShows: 22 },
    ],
    byHour: hours({ 6: 300, 18: 520, 19: 420 }),
    byBranch: [{ branchId: 'br_kor', branchName: 'Koramangala Depot', visits: 1240, occupancyBp: 7125 }],
    ...overrides,
  };
}

describe('Attendance', () => {
  it('states visits, people, no-shows and occupancy against the period before', () => {
    renderPanel(<Attendance data={attendance()} timeZone={TZ} />);
    expect(screen.getAllByText('1,240').length).toBeGreaterThan(0);
    expect(screen.getByText('310')).toBeInTheDocument();
    expect(screen.getByText('6.5% of booked seats')).toBeInTheDocument();
    expect(screen.getAllByText('71.3%').length).toBeGreaterThan(0);
    expect(screen.getByText('▲ 24.0% vs previous')).toBeInTheDocument();
    expect(screen.getByText('Koramangala Depot only.')).toBeInTheDocument();
  });

  it('names the busiest hour in the branch clock, and lists only hours with visits', () => {
    renderPanel(<Attendance data={attendance()} timeZone={TZ} />);
    expect(screen.getByRole('region', { name: 'Busiest hours · Asia/Kolkata' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Peak 18:00: 24 hours' })).toBeInTheDocument();
    const hourRows = within(screen.getByRole('region', { name: 'Busiest hours · Asia/Kolkata' })).getAllByRole('row');
    // Header plus the three hours that saw anybody.
    expect(hourRows).toHaveLength(4);
  });

  it('lists each day with its no-shows', () => {
    renderPanel(<Attendance data={attendance()} timeZone={TZ} />);
    const days = screen.getByRole('region', { name: 'Day by day' });
    const row = within(days).getByText('2026-08-02').closest('tr')!;
    expect(within(row).getByText('600')).toBeInTheDocument();
    expect(within(row).getByText('22')).toBeInTheDocument();
  });

  it('says nothing happened rather than inventing a peak or a rate', () => {
    renderPanel(
      <Attendance
        data={attendance({
          visits: { value: 0, previous: 0, changeBp: null },
          uniqueMembers: { value: 0, previous: 0, changeBp: null },
          noShows: { value: 0, previous: 0, changeBp: null },
          noShowRateBp: null,
          occupancyBp: null,
          series: [],
          byHour: hours(),
          byBranch: [],
        })}
        timeZone={TZ}
      />,
    );
    expect(screen.getByText('Nothing in range')).toBeInTheDocument();
    expect(screen.getByText('no bookings in range')).toBeInTheDocument();
    expect(screen.getByText('no capacity scheduled')).toBeInTheDocument();
    // Regression: 24 empty hours once reported a peak at midnight.
    expect(screen.queryByText(/Peak 00:00/)).not.toBeInTheDocument();
    expect(screen.getByText('No visits in range')).toBeInTheDocument();
  });

  it('says there is no prior period rather than a change from zero', () => {
    renderPanel(
      <Attendance
        data={attendance({
          meta: meta({ comparison: null }),
          visits: { value: 1240, previous: null, changeBp: null },
          uniqueMembers: { value: 310, previous: null, changeBp: null },
          noShows: { value: 42, previous: null, changeBp: null },
        })}
        timeZone={TZ}
      />,
    );
    expect(screen.getByText('No prior period to compare')).toBeInTheDocument();
    expect(screen.getAllByText('No prior period')).toHaveLength(3);
    expect(screen.queryByText(/vs previous/)).not.toBeInTheDocument();
  });
});
