/**
 * Money is integer minor units, everywhere, always. No floats reach a total.
 */

export interface Currency {
  code: string;
  symbol: string;
  minorPerMajor: number;
  locale: string;
}

export const CURRENCIES: Record<string, Currency> = {
  INR: { code: 'INR', symbol: '₹', minorPerMajor: 100, locale: 'en-IN' },
  USD: { code: 'USD', symbol: '$', minorPerMajor: 100, locale: 'en-US' },
  GBP: { code: 'GBP', symbol: '£', minorPerMajor: 100, locale: 'en-GB' },
  AED: { code: 'AED', symbol: 'AED ', minorPerMajor: 100, locale: 'en-AE' },
};

export function formatMoney(minor: number, code = 'INR'): string {
  const c = CURRENCIES[code] ?? CURRENCIES.INR!;
  const major = minor / c.minorPerMajor;
  const body = major.toLocaleString(c.locale, {
    minimumFractionDigits: minor % c.minorPerMajor === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `${c.symbol}${body}`;
}

/** Tax in basis points, applied to a minor-unit base. Rounds half up, once. */
export function taxOn(baseMinor: number, rateBp: number): number {
  return Math.round((baseMinor * rateBp) / 10_000);
}

export interface LineInput {
  quantity: number;
  unitMinor: number;
  taxRateBp: number;
  discountMinor?: number;
}

export interface Totals {
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
}

/** Tax is computed per line and summed, not computed on the rounded subtotal —
 *  the two differ by a rupee often enough to matter on a reconciliation. */
export function totalsFor(lines: LineInput[]): Totals {
  let subtotal = 0;
  let discount = 0;
  let tax = 0;
  for (const l of lines) {
    const gross = l.quantity * l.unitMinor;
    const disc = l.discountMinor ?? 0;
    const net = Math.max(0, gross - disc);
    subtotal += gross;
    discount += disc;
    tax += taxOn(net, l.taxRateBp);
  }
  return {
    subtotalMinor: subtotal,
    discountMinor: discount,
    taxMinor: tax,
    totalMinor: subtotal - discount + tax,
  };
}

export function invoiceStateFor(args: {
  totalMinor: number;
  paidMinor: number;
  refundedMinor: number;
  dueOn: string;
  today: string;
  voided: boolean;
}): 'draft' | 'open' | 'partially_paid' | 'paid' | 'overdue' | 'void' | 'partially_refunded' | 'refunded' {
  if (args.voided) return 'void';
  if (args.refundedMinor > 0) {
    return args.refundedMinor >= args.paidMinor ? 'refunded' : 'partially_refunded';
  }
  if (args.paidMinor <= 0) {
    return args.today > args.dueOn ? 'overdue' : 'open';
  }
  if (args.paidMinor < args.totalMinor) {
    return args.today > args.dueOn ? 'overdue' : 'partially_paid';
  }
  return 'paid';
}

/**
 * Dunning schedule. Retries back off, stop on success or on an opt-out, and
 * never run inside quiet hours — a payment reminder at 02:00 is a complaint,
 * not a collection (PF-BILL-005, PF-SUP-005).
 */
export const DUNNING_OFFSETS_DAYS = [0, 3, 7, 14] as const;

export interface DunningStep {
  attempt: number;
  offsetDays: number;
  channel: 'email' | 'sms' | 'in_app' | 'whatsapp';
  createsStaffTask: boolean;
}

export function dunningPlan(preferredChannels: string[]): DunningStep[] {
  const pick = (i: number): DunningStep['channel'] => {
    const allowed = preferredChannels.filter((c) =>
      ['email', 'sms', 'in_app', 'whatsapp'].includes(c),
    ) as DunningStep['channel'][];
    return allowed[i % Math.max(1, allowed.length)] ?? 'in_app';
  };
  return DUNNING_OFFSETS_DAYS.map((offsetDays, i) => ({
    attempt: i + 1,
    offsetDays,
    channel: pick(i),
    createsStaffTask: i === DUNNING_OFFSETS_DAYS.length - 1,
  }));
}

/** Quiet hours are branch-local. 21:00–08:00 by default. */
export function insideQuietHours(localMinutes: number, fromMin = 21 * 60, toMin = 8 * 60): boolean {
  return fromMin > toMin
    ? localMinutes >= fromMin || localMinutes < toMin
    : localMinutes >= fromMin && localMinutes < toMin;
}
