/**
 * Time helpers. Every stored timestamp is epoch milliseconds UTC; every
 * user-facing date is computed in the *branch's* timezone, never the server's.
 */

export const now = (): number => Date.now();

export const iso = (ms: number): string => new Date(ms).toISOString();

export function isoDate(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(ms);
}

export function localTime(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(ms);
}

/** Minutes past midnight in the given zone. Drives opening-hours checks. */
export function localMinutes(ms: number, timeZone: string): number {
  const [h, m] = localTime(ms, timeZone).split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** 0 = Monday. */
export function localDayIndex(ms: number, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short' }).format(ms);
  const order = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const idx = order.indexOf(name);
  return idx === -1 ? 0 : idx;
}

export function localHour(ms: number, timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false }).format(ms));
}

/**
 * The instant a local calendar day begins, as epoch milliseconds.
 *
 * Reporting periods are stated as dates — "1 to 31 August" — but every stored
 * timestamp is epoch ms UTC, so a range has to be turned into two instants
 * before anything can be summed. Doing that in the server's zone is how a
 * 23:30 sale in Bengaluru lands in the previous day's takings when the process
 * happens to run in UTC, and why the same report gives two answers depending
 * on where it is run.
 *
 * The offset is found by asking `Intl` what the wall clock reads in that zone
 * at a candidate instant and correcting by the difference. Two passes settle
 * it, which matters on the days a zone shifts: the first guess can land on the
 * wrong side of a DST boundary and the second pass pulls it back.
 */
export function startOfLocalDay(isoDay: string, timeZone: string): number {
  const [y, m, d] = isoDay.split('-').map(Number);
  const utcGuess = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);

  const offsetAt = (ms: number): number => {
    // What the wall clock in `timeZone` reads at this instant, read back as if
    // it were UTC. The gap between the two is the zone's offset there.
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(ms);
    const at = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? 0);
    // `hour12: false` yields 24 for midnight in some environments.
    const hour = at('hour') % 24;
    return Date.UTC(at('year'), at('month') - 1, at('day'), hour, at('minute'), at('second')) - ms;
  };

  let ms = utcGuess - offsetAt(utcGuess);
  ms = utcGuess - offsetAt(ms);
  return ms;
}

/** The half-open range [from, to) covering whole local days, inclusive of `toDay`. */
export function localDayRange(fromDay: string, toDay: string, timeZone: string): { from: number; to: number } {
  return { from: startOfLocalDay(fromDay, timeZone), to: startOfLocalDay(addDays(toDay, 1), timeZone) };
}

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
}

export function startOfWeek(isoDay: string): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** "2h ago", "yesterday" — used wherever the exact stamp is noise. */
export function relativeTime(ms: number, from = Date.now()): string {
  const delta = from - ms;
  if (delta < MINUTE) return 'just now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  if (delta < 2 * DAY) return 'yesterday';
  if (delta < 7 * DAY) return `${Math.floor(delta / DAY)} days ago`;
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(ms);
}

export function durationLabel(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function clock(sec: number): string {
  const m = Math.floor(sec / 60);
  return `${m}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}
