/* ============================================================================
   Report arithmetic — PF-RPT-002.

   The awkward parts of a report are not the SQL; they are the handful of
   places where an honest answer is "I cannot say". Those live here, pure, so
   they can be tested without a database and so every report answers them the
   same way.
   ========================================================================= */

/** A figure beside the same figure a period earlier. */
export interface Compared {
  value: number;
  previous: number | null;
  changeBp: number | null;
}

/**
 * Pair a figure with its comparison.
 *
 * `previous === null` means there was no prior period at all — the first month
 * a branch existed — and the change is unknowable rather than 100%. A previous
 * value of *zero* is a different thing: it happened, and it was nothing. Going
 * from 0 to 40 is not "up 100%", it is growth from a base that cannot be
 * divided by, so the change stays null and the console prints the pair rather
 * than inventing a ratio.
 */
export function compare(value: number, previous: number | null): Compared {
  if (previous === null || previous === 0) return { value, previous, changeBp: null };
  return { value, previous, changeBp: Math.round(((value - previous) / previous) * 10_000) };
}

/**
 * A ratio in basis points, or null when the denominator is zero.
 *
 * Every rate in this module goes through here. A no-show rate of 0% reads as
 * "nobody missed a class"; on a day with no bookings at all the truthful
 * answer is that there is no rate, and the two must not look alike.
 */
export function rateBp(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10_000);
}

/** Whole days from `from` to `to` inclusive, both local ISO dates. */
export function daysInPeriod(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.floor((end - start) / 86_400_000) + 1;
}

/** Shift a local ISO date by whole days, staying in the calendar. */
export function shiftDay(isoDay: string, days: number): string {
  const at = Date.parse(`${isoDay}T00:00:00Z`);
  return new Date(at + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The window immediately before this one, of equal length.
 *
 * Returned even when it predates the tenant's own history: whether any data
 * exists there is a question for the database, and answering it here would
 * mean this function needed one. The caller turns an empty result into a null
 * comparison — which is why `ReportMeta.comparison` and the `previous` on each
 * figure are allowed to disagree about nothing existing.
 */
export function previousPeriod(from: string, to: string): { from: string; to: string } {
  const days = daysInPeriod(from, to);
  return { from: shiftDay(from, -days), to: shiftDay(to, -days) };
}

/**
 * Net revenue: what was actually kept.
 *
 * Refunds subtract, because a report that shows gross alone flatters a month
 * in which half the takings went back. Both are carried on the wire so the
 * difference stays visible rather than being folded into one number.
 */
export function netMinor(grossMinor: number, refundedMinor: number): number {
  return grossMinor - refundedMinor;
}

/**
 * Average revenue per paying member.
 *
 * Null rather than zero when nobody paid: dividing by no members is not an
 * average of nothing, it is the absence of one.
 */
export function arpuMinor(netMinorTotal: number, payingMembers: number): number | null {
  if (payingMembers <= 0) return null;
  return Math.round(netMinorTotal / payingMembers);
}

/**
 * The month a date belongs to, as a cohort key.
 *
 * Cohorts are months because a gym's joining pattern is monthly — a campaign,
 * a New Year, a corporate tie-up — and weekly cohorts on a 39-member branch
 * produce buckets of two that read as noise.
 */
export function cohortOf(isoDay: string): string {
  return isoDay.slice(0, 7);
}

/**
 * Sum money only within a currency.
 *
 * A tenant that changed currency mid-range has invoices in both, and adding
 * them produces a number that is wrong in a way nobody can see by looking at
 * it. Callers render each entry separately and say the range is mixed.
 */
export function groupByCurrency<T extends { currency: string }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const held = out.get(row.currency);
    if (held) held.push(row);
    else out.set(row.currency, [row]);
  }
  return out;
}

/**
 * One CSV field.
 *
 * Quoted whenever it holds a comma, a quote or a newline, with quotes doubled.
 * A member called `Rao, Priya` and a cancellation reason with a line break in
 * it are both ordinary, and either one silently shifts every later column of
 * that row if this is skipped.
 *
 * A leading `=`, `+`, `-` or `@` is prefixed with a single quote. Those are
 * formula characters: a spreadsheet opening the export would otherwise
 * evaluate the cell, which is both wrong and a way to get a recipient's
 * machine to fetch a URL from a file they believe is a list of numbers.
 */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** A CSV document with a header row. Rows are already ordered by the caller. */
export function toCsv(headers: string[], rows: Array<Array<unknown>>): string {
  const lines = [headers.map(csvField).join(',')];
  for (const row of rows) lines.push(row.map(csvField).join(','));
  // Trailing newline: POSIX tools treat a file without one as truncated.
  return `${lines.join('\n')}\n`;
}
