import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { OccupancyTrace } from '../OccupancyTrace';

/* ============================================================================
   The signature readout.

   Its most common state is the one nobody looks at while building it: a gym
   that has not opened yet, twenty-four hours of zeroes. The scale needs a
   floor of 1 to avoid dividing by zero; the *figure* must not inherit it. And
   `hourly` counts arrivals, so the figure is the busiest hour for entries, not
   peak occupancy.
   ========================================================================= */

const quiet = Array.from({ length: 24 }, () => 0);

const busy = Array.from({ length: 24 }, (_unused, hour) => (hour === 7 ? 42 : hour === 18 ? 31 : 0));

describe('occupancy trace headline', () => {
  it('names the busiest hour by arrivals, not as peak occupancy', () => {
    const hourly = [...quiet];
    hourly[21] = 9;
    render(<OccupancyTrace hourly={hourly} currentHour={23} inside={13} capacity={120} label="quiet" />);
    expect(screen.getByText('Busiest hour')).toBeInTheDocument();
    expect(screen.getByText('9 arrivals')).toBeInTheDocument();
    expect(screen.queryByText(/peak today/i)).not.toBeInTheDocument();
  });

  it('does not print a negative hour before anyone has arrived', () => {
    // `Math.max(1, ...zeroes)` is 1, `indexOf(1)` is -1, and the readout said
    // "1 at -1:00" every morning before the doors opened.
    render(<OccupancyTrace hourly={quiet} currentHour={6} inside={0} capacity={120} label="quiet" />);
    expect(screen.queryByText(/-1:00/)).not.toBeInTheDocument();
    expect(screen.getByText('0 arrivals')).toBeInTheDocument();
  });

  it('zero-pads the busiest hour', () => {
    render(<OccupancyTrace hourly={busy} currentHour={12} inside={12} capacity={120} label="Steady" />);
    expect(screen.getByText('42 arrivals')).toBeInTheDocument();
    expect(screen.getByText(/07:00/)).toBeInTheDocument();
  });

  it('tells a screen reader the same thing the figure says', () => {
    const { rerender } = render(
      <OccupancyTrace hourly={quiet} currentHour={6} inside={0} capacity={120} label="Quiet" />,
    );
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('Nobody has come in yet today');

    rerender(<OccupancyTrace hourly={busy} currentHour={12} inside={12} capacity={120} label="Steady" />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('Busiest hour 07:00 with 42 arrivals');
  });
});
