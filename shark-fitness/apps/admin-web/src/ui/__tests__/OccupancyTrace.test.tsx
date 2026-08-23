import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { OccupancyTrace } from '../OccupancyTrace';

/* ============================================================================
   The signature readout.

   Its most common state is the one nobody looks at while building it: a gym
   that has not opened yet, twenty-four hours of zeroes. The scale needs a
   floor of 1 to avoid dividing by zero; the *figure* must not inherit it.
   ========================================================================= */

const quiet = Array.from({ length: 24 }, () => 0);

const busy = Array.from({ length: 24 }, (_unused, hour) => (hour === 7 ? 42 : hour === 18 ? 31 : 0));

describe('OccupancyTrace — the peak it reports', () => {
  it('says nobody has come in rather than inventing a peak of one at hour minus one', () => {
    // `Math.max(1, ...zeroes)` is 1, `indexOf(1)` is -1, and the readout said
    // "1 at -1:00" every morning before the doors opened.
    render(<OccupancyTrace hourly={quiet} currentHour={6} inside={0} capacity={120} label="Quiet" />);
    expect(screen.getByText('No entries yet')).toBeInTheDocument();
    expect(screen.queryByText(/-1:00/)).not.toBeInTheDocument();
  });

  it('names the busiest hour, zero-padded', () => {
    render(<OccupancyTrace hourly={busy} currentHour={12} inside={12} capacity={120} label="Steady" />);
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('at 07:00')).toBeInTheDocument();
  });

  it('tells a screen reader the same thing the figure says', () => {
    const { rerender } = render(
      <OccupancyTrace hourly={quiet} currentHour={6} inside={0} capacity={120} label="Quiet" />,
    );
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('Nobody has come in yet today');

    rerender(<OccupancyTrace hourly={busy} currentHour={12} inside={12} capacity={120} label="Steady" />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('Peak of 42 at 07:00');
  });
});
