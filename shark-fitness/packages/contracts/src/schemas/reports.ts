import { z } from 'zod';

/* ============================================================================
   Reports and analytics — PF-RPT-001…006.

   Four rules run through every shape in this file, and they are the reason it
   is worth reading before adding to it.

   **Withheld is not zero.** `report.financial` gates money separately from
   `report.view`, so a branch manager can open Reports, work the attendance and
   membership figures, and see revenue as *absent*. Every gated figure is
   `null` with its name listed in `meta.restricted`. A zero would be a
   falsehood in a report (PF-RPT-005) and the console would render it as a real
   number — "revenue this month: ₹0" is the kind of thing somebody escalates.

   **Money is integer minor units, and never summed across currencies.** A
   range that spans a currency change reports each currency separately and sets
   `mixedCurrency`, because adding rupees to dirhams produces a number that is
   wrong in a way nobody can see.

   **Every figure declares its freshness** (PF-RPT-004). Anything derived from
   a stored rollup carries the instant that rollup was computed, so a figure
   that is four hours old says so rather than looking live.

   **A missing comparison is `null`, not zero.** A range with no prior period —
   the first month a branch existed — has nothing to compare against, and
   "down 100%" is a fabrication.
   ========================================================================= */

/** How current a figure is. `batch` means it came from a stored rollup. */
export const ReportFreshness = z.enum(['realtime', 'near_realtime', 'batch']);
export type ReportFreshness = z.infer<typeof ReportFreshness>;

export const ReportGrain = z.enum(['day', 'week', 'month']);
export type ReportGrain = z.infer<typeof ReportGrain>;

export interface ReportPeriod {
  /** Local calendar dates in the reporting timezone, inclusive. */
  from: string;
  to: string;
  /** Whole days in the period. Drives the comparison window's length. */
  days: number;
  label: string;
}

export interface ReportMeta {
  period: ReportPeriod;
  /**
   * The immediately preceding window of equal length, or `null` when there is
   * nothing before it to compare against.
   */
  comparison: ReportPeriod | null;
  /** The zone every boundary in this report was computed in. */
  timeZone: string;
  /** The branches actually covered — never more than the caller may see. */
  branchIds: string[];
  scopeNote: string;
  freshness: ReportFreshness;
  /** When the underlying figures were computed, ISO-8601 UTC. */
  computedAt: string;
  /** Field names withheld for want of a permission, with the reason. */
  restricted: string[];
  /** True when the caller holds `report.financial`. */
  canSeeFinancial: boolean;
  /** True when the caller holds `report.export`. */
  canExport: boolean;
}

/** A figure and the same figure a period earlier. `previous` null = no prior. */
export interface Compared {
  value: number;
  previous: number | null;
  /** Basis points of change, null when there is no prior period or it was 0. */
  changeBp: number | null;
}

export interface MoneyByCurrency {
  currency: string;
  grossMinor: number;
  netMinor: number;
  refundedMinor: number;
  discountMinor: number;
  taxMinor: number;
  invoices: number;
}

export interface RevenueSeriesPoint {
  date: string;
  netMinor: number;
  grossMinor: number;
  refundedMinor: number;
  invoices: number;
}

export interface RevenueReport {
  meta: ReportMeta;
  /**
   * Null without `report.financial`, and *also* null when the range spans more
   * than one currency — there is no single total to state, and inventing one
   * by adding rupees to dirhams is the failure this shape exists to prevent.
   * `byCurrency` carries the truth in both cases; `meta.restricted` says which
   * of the two reasons applies.
   */
  totals: {
    grossMinor: Compared;
    netMinor: Compared;
    refundedMinor: number;
    discountMinor: number;
    taxMinor: number;
    invoices: Compared;
    /** Net divided by paying members. */
    arpuMinor: number | null;
  } | null;
  /** More than one entry means the range spans a currency change. */
  byCurrency: MoneyByCurrency[];
  mixedCurrency: boolean;
  /**
   * The currency the daily series is denominated in — the one with the most
   * invoices in range. Null when there were none. A series has to be one
   * currency to be a line, so when the range is mixed this names which.
   */
  seriesCurrency: string | null;
  series: RevenueSeriesPoint[];
  byBranch: Array<{ branchId: string; branchName: string; netMinor: number; invoices: number }>;
  byProduct: Array<{ productId: string | null; productName: string; netMinor: number; count: number }>;
  byMethod: Array<{ method: string; amountMinor: number; payments: number }>;
}

export interface MembershipReport {
  meta: ReportMeta;
  joins: Compared;
  cancellations: Compared;
  freezes: Compared;
  renewals: Compared;
  activeAtEnd: number;
  /** Cancellations over the active base, in basis points. */
  churnBp: number | null;
  netChange: number;
  /** Lifetime value is money, so it needs `report.financial`. */
  ltvMinor: number | null;
  series: Array<{ date: string; joins: number; cancellations: number }>;
  byProduct: Array<{ productId: string; productName: string; joins: number; cancellations: number; activeAtEnd: number }>;
}

export interface AttendanceReport {
  meta: ReportMeta;
  visits: Compared;
  uniqueMembers: Compared;
  /** Booked seats that nobody attended. */
  noShows: Compared;
  noShowRateBp: number | null;
  /** Booked over capacity across every session in range, in basis points. */
  occupancyBp: number | null;
  series: Array<{ date: string; visits: number; noShows: number }>;
  /** 0–23 in the reporting timezone. */
  byHour: Array<{ hour: number; visits: number }>;
  byBranch: Array<{ branchId: string; branchName: string; visits: number; occupancyBp: number | null }>;
}

export interface TrainerReport {
  meta: ReportMeta;
  rows: Array<{
    trainerId: string;
    trainerName: string;
    sessionsLed: number;
    seatsBooked: number;
    seatsCapacity: number;
    utilisationBp: number | null;
    attended: number;
    noShows: number;
    membersCoached: number;
    /** Members still active at period end over members coached. */
    retentionBp: number | null;
  }>;
}

export interface RetentionReport {
  meta: ReportMeta;
  bands: { high: number; watch: number; low: number };
  /** Joined-month cohorts, each with what fraction is still active. */
  cohorts: Array<{
    cohort: string;
    joined: number;
    stillActive: number;
    retainedBp: number | null;
  }>;
  atRiskValueMinor: number | null;
}

/* — Export ——————————————————————————————————————————————————— */

export const ReportKind = z.enum(['revenue', 'membership', 'attendance', 'trainer', 'retention']);
export type ReportKind = z.infer<typeof ReportKind>;

export interface ReportExport {
  filename: string;
  /** `text/csv`. The body is the complete filtered set, not one UI page. */
  contentType: string;
  rows: number;
  csv: string;
}
