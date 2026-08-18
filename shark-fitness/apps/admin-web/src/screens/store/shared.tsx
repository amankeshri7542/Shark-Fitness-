import type { ReactNode } from 'react';
import type { StoreFinancialAccess } from '@shark/contracts';
import { Chip, Restricted, type Tone } from '../../ui/console';

/* ============================================================================
   Store shared pieces.

   The Store is a plain-register surface (`tone.ts`): payment, stock and money
   never reach for the predator voice the training floor uses. Every string in
   this module says what happened, in the words a person at a counter would
   use — "Sold", "Returned", "Short on receipt" — and nothing here is clever.
   ========================================================================= */

/** Indian rupees from integer minor units. Minus sign, not a bracket. */
export function money(minor: number): string {
  const sign = minor < 0 ? '−' : '';
  return `${sign}₹${Math.abs(minor / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * A money field the server may have withheld.
 *
 * `null` from the API means "your role may not see this", which is not the
 * same as zero and must never render as one.
 */
export function Money({ minor, className }: { minor: number | null; className?: string }): ReactNode {
  if (minor === null) return <Restricted />;
  return <span className={className}>{money(minor)}</span>;
}

export const time = (iso: string): string =>
  new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

export const dateTime = (iso: string): string =>
  new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

export const dayMonth = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });

/* — Status ————————————————————————————————————————————————————— */

/** Colour is never the only signal — `Chip` pairs every tone with a glyph. */
const ORDER_TONE: Record<string, Tone> = {
  paid: 'good',
  returned: 'warn',
  partially_returned: 'warn',
  voided: 'bad',
};

const ORDER_LABEL: Record<string, string> = {
  paid: 'Sold',
  returned: 'Returned',
  partially_returned: 'Part returned',
  voided: 'Voided',
};

export function OrderStateChip({ state, kind }: { state: string; kind: string }) {
  if (kind === 'return') return <Chip tone="warn">Refund</Chip>;
  return <Chip tone={ORDER_TONE[state] ?? 'neutral'}>{ORDER_LABEL[state] ?? state}</Chip>;
}

const TRANSFER_TONE: Record<string, Tone> = {
  draft: 'neutral',
  dispatched: 'warn',
  received: 'good',
  cancelled: 'bad',
};

const TRANSFER_LABEL: Record<string, string> = {
  draft: 'Draft',
  dispatched: 'In transit',
  received: 'Received',
  cancelled: 'Cancelled',
};

export function TransferStateChip({ state }: { state: string }) {
  return <Chip tone={TRANSFER_TONE[state] ?? 'neutral'}>{TRANSFER_LABEL[state] ?? state}</Chip>;
}

export function StockChip({ onHand, lowStock }: { onHand: number; lowStock: boolean }) {
  const tone: Tone = onHand <= 0 ? 'bad' : lowStock ? 'warn' : 'good';
  return <Chip tone={tone}>{onHand}</Chip>;
}

/* — Movement vocabulary ————————————————————————————————————————— */

export const MOVEMENT_LABEL: Record<string, string> = {
  purchase: 'Purchase',
  sale: 'Sale',
  return: 'Return',
  transfer_out: 'Sent out',
  transfer_in: 'Received in',
  adjustment: 'Adjustment',
  damage: 'Damage',
};

export const TENDER_LABEL: Record<string, string> = {
  cash: 'Cash',
  card: 'Card',
  upi: 'UPI',
  account: 'On account',
};

/** Card auth codes and UPI references are worth capturing; cash has none. */
export const TENDER_NEEDS_REFERENCE: Record<string, boolean> = {
  cash: false,
  card: true,
  upi: true,
  account: false,
};

/* — Permission-aware financial panels ——————————————————————————— */

/**
 * Wraps a block of financial figures. When the role cannot see them the block
 * says so in its own words rather than rendering as an empty panel, which
 * would read as "there is no data" (Design PRD: permission denial SHALL NOT
 * masquerade as missing data).
 */
export function FinancialGate({
  financial,
  children,
}: {
  financial: StoreFinancialAccess | undefined;
  children: ReactNode;
}) {
  if (financial && !financial.canSeeMargin) {
    return (
      <div className="flex flex-col items-start gap-1.5 p-4">
        <span className="font-utility text-[10px] font-semibold uppercase tracking-[0.14em] text-foam-45">
          Not available to your role
        </span>
        <p className="max-w-[42ch] text-[13px] leading-relaxed text-foam-65">
          Cost, margin and stock value need financial reporting access. Sales, units and what needs
          reordering are below.
        </p>
      </div>
    );
  }
  return <>{children}</>;
}
