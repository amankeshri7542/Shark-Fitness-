import { describe, expect, it } from 'vitest';
import {
  arpuMinor,
  cohortOf,
  compare,
  csvField,
  daysInPeriod,
  groupByCurrency,
  netMinor,
  previousPeriod,
  rateBp,
  shiftDay,
  toCsv,
} from '../reports.js';

/* The parts of a report where the honest answer is "I cannot say". Each of
   these has a way of being quietly wrong that nobody notices until somebody
   makes a decision on it. */

describe('compare — a missing comparison is not a fall to zero', () => {
  it('reports no change at all when there is no prior period', () => {
    // PF-RPT edge case: a range with no prior comparison period. The first
    // month a branch existed has nothing behind it, and "down 100%" is a
    // fabrication somebody will act on.
    expect(compare(42, null)).toEqual({ value: 42, previous: null, changeBp: null });
  });

  it('reports no ratio when the prior period was zero', () => {
    // Zero is a fact — it happened, and it was nothing — but it cannot be
    // divided by. The pair is shown instead of an invented percentage.
    expect(compare(40, 0)).toEqual({ value: 40, previous: 0, changeBp: null });
  });

  it('computes the change in basis points', () => {
    expect(compare(120, 100).changeBp).toBe(2000);
    expect(compare(80, 100).changeBp).toBe(-2000);
  });

  it('keeps a fall to nothing distinct from having no comparison', () => {
    expect(compare(0, 50)).toEqual({ value: 0, previous: 50, changeBp: -10_000 });
  });
});

describe('rateBp — no denominator means no rate', () => {
  it('is null rather than zero when nothing could have happened', () => {
    // A no-show rate of 0% reads as "nobody missed a class". On a day with no
    // bookings the truth is that there is no rate, and they must not look alike.
    expect(rateBp(0, 0)).toBeNull();
  });

  it('is zero when something could have happened and did not', () => {
    expect(rateBp(0, 20)).toBe(0);
  });

  it('converts to basis points', () => {
    expect(rateBp(1, 4)).toBe(2500);
    expect(rateBp(2, 3)).toBe(6667);
  });
});

describe('periods', () => {
  it('counts both endpoints', () => {
    expect(daysInPeriod('2026-08-01', '2026-08-31')).toBe(31);
    expect(daysInPeriod('2026-08-19', '2026-08-19')).toBe(1);
  });

  it('puts the comparison window immediately before, at equal length', () => {
    expect(previousPeriod('2026-08-01', '2026-08-31')).toEqual({ from: '2026-07-01', to: '2026-07-31' });
  });

  it('does not drift across a month boundary on a short range', () => {
    expect(previousPeriod('2026-03-01', '2026-03-07')).toEqual({ from: '2026-02-22', to: '2026-02-28' });
  });

  it('shifts days without leaving the calendar', () => {
    expect(shiftDay('2026-02-28', 1)).toBe('2026-03-01');
    expect(shiftDay('2026-01-01', -1)).toBe('2025-12-31');
  });
});

describe('money', () => {
  it('nets refunds off gross rather than hiding them', () => {
    expect(netMinor(500_000, 120_000)).toBe(380_000);
  });

  it('has no average revenue per member when nobody paid', () => {
    expect(arpuMinor(0, 0)).toBeNull();
  });

  it('averages over paying members only', () => {
    expect(arpuMinor(300_000, 4)).toBe(75_000);
  });

  it('never sums across currencies', () => {
    // PF-RPT edge case: a currency change inside the selected range. Adding
    // rupees to dirhams gives a number that is wrong in a way nobody can see.
    const grouped = groupByCurrency([
      { currency: 'INR', amountMinor: 100 },
      { currency: 'AED', amountMinor: 50 },
      { currency: 'INR', amountMinor: 25 },
    ]);
    expect([...grouped.keys()].sort()).toEqual(['AED', 'INR']);
    expect(grouped.get('INR')).toHaveLength(2);
    expect(grouped.get('AED')).toHaveLength(1);
  });
});

describe('cohorts', () => {
  it('buckets by joining month', () => {
    expect(cohortOf('2026-08-19')).toBe('2026-08');
  });
});

describe('csv', () => {
  it('quotes a field holding a comma, so later columns do not shift', () => {
    expect(csvField('Rao, Priya')).toBe('"Rao, Priya"');
  });

  it('doubles embedded quotes', () => {
    expect(csvField('She said "no"')).toBe('"She said ""no"""');
  });

  it('quotes a field holding a newline', () => {
    expect(csvField('line one\nline two')).toBe('"line one\nline two"');
  });

  it('defuses a field a spreadsheet would run as a formula', () => {
    // Not cosmetic: a cancellation reason beginning "=" is evaluated on open,
    // and the formula can be made to fetch a URL from a file the recipient
    // believes is a list of numbers.
    expect(csvField('=1+1')).toBe("'=1+1");
    expect(csvField('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvField('-2+3')).toBe("'-2+3");
  });

  it('leaves an ordinary field alone', () => {
    expect(csvField('Koramangala')).toBe('Koramangala');
    expect(csvField(1180)).toBe('1180');
  });

  it('writes an empty cell for a withheld figure rather than a zero', () => {
    // Financial columns a role may not see are null on the wire and must stay
    // empty in the export. A zero there is a number somebody would read.
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
  });

  it('builds a document with a header and a trailing newline', () => {
    expect(toCsv(['branch', 'net'], [['Koramangala', 1180], ['HSR, Layout', null]])).toBe(
      'branch,net\nKoramangala,1180\n"HSR, Layout",\n',
    );
  });
});
