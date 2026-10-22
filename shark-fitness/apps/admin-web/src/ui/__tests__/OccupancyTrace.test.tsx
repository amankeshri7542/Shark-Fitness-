import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OccupancyTrace } from '../OccupancyTrace';

const quiet = Array.from({ length: 24 }, () => 0);

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
    render(<OccupancyTrace hourly={quiet} currentHour={6} inside={0} capacity={120} label="quiet" />);
    expect(screen.queryByText(/-1:00/)).not.toBeInTheDocument();
    expect(screen.getByText('0 arrivals')).toBeInTheDocument();
  });
});
