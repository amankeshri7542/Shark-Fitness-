import type { ReactNode } from 'react';
import type { Compared, ReportMeta } from '@shark/contracts';
import { Chip, Freshness, Label, cx } from '../../ui/console';

/* ============================================================================
   The parts every report surface shares.

   Reports is deliberately not a dashboard of rounded KPI cards. The evidence
   is the table; the strip above it exists to say what the table is *of* —
   which period, which branches, how fresh, and what changed — in as little
   room as that takes.
   ========================================================================= */

/** Integer minor units to a readable amount. Money never becomes a float. */
export function money(minor: number | null | undefined, currency = 'INR'): string {
  if (minor === null || minor === undefined) return '—';
  const symbol = currency === 'INR' ? '₹' : `${currency} `;
  return `${symbol}${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Basis points to a percentage. Null stays absent rather than becoming 0%. */
export function pct(bp: number | null | undefined, digits = 1): string {
  if (bp === null || bp === undefined) return '—';
  return `${(bp / 100).toFixed(digits)}%`;
}

export const count = (n: number | null | undefined): string =>
  n === null || n === undefined ? '—' : n.toLocaleString('en-IN');

/**
 * A figure's movement against the period before it.
 *
 * Three states, and the difference between them is the whole point: a real
 * change, a comparison that exists but cannot produce a ratio, and no prior
 * period at all. Only the first gets a percentage.
 */
export function Delta({ of, invert = false }: { of: Compared; invert?: boolean }) {
  if (of.previous === null) {
    return <span className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">No prior period</span>;
  }
  if (of.changeBp === null) {
    return (
      <span className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
        was {of.previous.toLocaleString('en-IN')}
      </span>
    );
  }
  const up = of.changeBp > 0;
  // On a no-show or a cancellation count, up is the bad direction.
  const good = invert ? !up : up;
  return (
    <span
      className={cx(
        'font-utility text-[10px] uppercase tracking-[0.1em] tabular-nums',
        of.changeBp === 0 ? 'text-foam-35' : good ? 'text-kelp' : 'text-chum',
      )}
    >
      {up ? '▲' : of.changeBp === 0 ? '·' : '▼'} {pct(Math.abs(of.changeBp))} vs previous
    </span>
  );
}

/**
 * The summary strip.
 *
 * Seamed cells sharing hairlines, the same idiom as every other module's
 * header — not a wall of floating cards. A figure that is withheld shows a
 * reason where the number would be, because a blank cell and a zero both read
 * as facts.
 */
export function Strip({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-px border-b border-line bg-line md:grid-cols-4">{children}</div>;
}

export function Cell({
  label,
  value,
  unit,
  delta,
  withheld,
}: {
  label: string;
  value: string;
  unit?: string;
  delta?: ReactNode;
  /** Shown instead of the figure when a permission or a rule withholds it. */
  withheld?: string;
}) {
  return (
    <div className="flex flex-col gap-1 bg-panel px-3.5 py-3">
      <Label>{label}</Label>
      {withheld ? (
        <>
          <div className="font-utility text-[12px] uppercase tracking-[0.1em] text-foam-35">Withheld</div>
          <p className="text-[11px] leading-relaxed text-foam-45">{withheld}</p>
        </>
      ) : (
        <>
          <div className="font-display text-[22px] leading-none tabular-nums">{value}</div>
          {unit ? <div className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">{unit}</div> : null}
          {delta}
        </>
      )}
    </div>
  );
}

/**
 * What this report is of: the period, the scope, and how fresh it is.
 *
 * Freshness sits beside the figures rather than in a footnote (PF-RPT-004) —
 * a four-hour-old number that looks live is the one somebody quotes in a
 * meeting.
 */
export function ReportContext({ meta, timeZone }: { meta: ReportMeta; timeZone: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-hull px-3.5 py-2">
      <span className="font-utility text-[10px] uppercase tracking-[0.12em] text-foam-45">
        {meta.period.from} → {meta.period.to}
      </span>
      <span className="font-utility text-[10px] uppercase tracking-[0.12em] text-foam-35">
        {meta.period.days} days · {meta.timeZone}
      </span>
      <Chip tone="neutral">{meta.scopeNote}</Chip>
      {meta.comparison ? (
        <span className="font-utility text-[10px] uppercase tracking-[0.12em] text-foam-35">
          vs {meta.comparison.from} → {meta.comparison.to}
        </span>
      ) : (
        <Chip tone="warn">No prior period to compare</Chip>
      )}
      <span className="flex-1" />
      <Freshness kind={meta.freshness} asOf={meta.computedAt} timeZone={timeZone} />
    </div>
  );
}

/**
 * A bare column chart.
 *
 * Deliberately small and unlabelled beyond its axis ends: the trend answers
 * "is this going up", and the table underneath answers everything else. A
 * charting library for this would be a dependency and a second visual language
 * for the sake of a shape the console can already draw with divs.
 */
export function Trend({
  points,
  label,
  format,
}: {
  points: Array<{ date: string; value: number }>;
  label: string;
  format: (value: number) => string;
}) {
  const peak = Math.max(1, ...points.map((p) => p.value));
  return (
    <figure className="border-b border-line px-3.5 py-3">
      <figcaption className="flex items-baseline gap-2">
        <Label>{label}</Label>
        <span className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35 tabular-nums">
          peak {format(peak)}
        </span>
      </figcaption>
      <div className="mt-2 flex h-24 items-end gap-px overflow-x-auto" role="img" aria-label={`${label}: ${points.length} days`}>
        {points.map((p) => (
          <div
            key={p.date}
            className="min-w-[3px] flex-1 bg-sonar-dim transition-[height] hover:bg-sonar"
            style={{ height: `${Math.max(2, (p.value / peak) * 100)}%` }}
            // The value belongs to the bar, so a pointer user gets it without
            // a legend and a screen-reader user gets the table below instead.
            title={`${p.date}: ${format(p.value)}`}
          />
        ))}
      </div>
      {points.length > 0 ? (
        <div className="mt-1 flex justify-between font-utility text-[9px] uppercase tracking-[0.1em] text-foam-35">
          <span>{points[0]!.date}</span>
          <span>{points[points.length - 1]!.date}</span>
        </div>
      ) : null}
    </figure>
  );
}
