import { and, asc, desc, eq, gte, inArray, lte, ne } from 'drizzle-orm';
import { db, schema, transact } from '../db/client.js';
import { branchScope, requirePermission, type RequestContext } from '../lib/context.js';
import { audit } from '../lib/audit.js';
import { invalid, notFound, precondition } from '../lib/errors.js';
import { id } from '../lib/ids.js';
import { isoDate, now } from '../lib/time.js';
import { branchTimeZone } from '../lib/branch-time.js';
import { loadStaffInScope } from './staff.js';

/**
 * Staff commission (PF-STAFF).
 *
 * `commission_rates` and `commission_lines` existed and nothing read or wrote
 * them outside the seed: the shape of a commission system with no commission
 * system in it. This is the workflow that fills them, and it is deliberately
 * conservative.
 *
 * **Commission accrues on money actually collected, never on money invoiced.**
 * The basis is a succeeded payment or a paid POS order, so an unpaid invoice
 * earns nobody anything and a gym never pays commission on a debt.
 *
 * **Tax is not commissionable.** The basis is net of tax and net of discount:
 * tax is collected on the government's behalf and was never the gym's revenue
 * to share.
 *
 * **Nothing here claims a payment provider settled anything.** `payments`
 * records that cash or a card was taken at a desk; `provider` is null across
 * this system. The evidence written on every line says which payment row it
 * came from and by what method it was *recorded*, and stops there. A
 * commission line is a claim about a gym's own bookkeeping, not about a
 * processor's.
 *
 * **A correction is a compensating entry, never an edit.** A returned sale or
 * a mis-rated line produces a second row with the negative amount citing the
 * first. The original keeps saying what it always said, which is the only
 * arrangement that survives somebody asking why a number changed.
 *
 * **Calculating and approving are different permissions.** `staff.commission`
 * reads; `staff.commission.approve` signs off and marks paid. A regional
 * manager can see their branch's figures and cannot approve them.
 */

export type CommissionLine = typeof schema.commissionLines.$inferSelect;

/** The transaction kinds commission can be earned on. `session` exists in the
 *  rate table and in the seed's per-staff rules; it has no eligible
 *  transaction source in this release and is listed so a rate configured for
 *  it is visibly unused rather than silently ignored. */
export const COMMISSION_KINDS = ['sale', 'package', 'session'] as const;
export type CommissionKind = (typeof COMMISSION_KINDS)[number];

/* ============================================================================
   Rules
   ========================================================================= */

export interface ResolvedRate {
  ratePct: number;
  /** Which rule produced it, recorded on every line so a figure can always be
   *  traced back to the rule in force when it was calculated. */
  ruleVersion: string;
  source: 'staff' | 'tenant';
}

/**
 * The rate for one member of staff and one kind, on one date.
 *
 * Per-staff rules win over the tenant table — that is what a negotiated rate
 * is. The tenant fallback picks the newest rate effective on or before the
 * date, so recalculating a closed period cannot pick up a rate that was
 * introduced after it ended.
 */
export function resolveRate(
  tenantId: string,
  staff: { id: string; commissionRules: Array<{ kind: string; ratePct: number }> },
  kind: CommissionKind,
  onDate: string,
): ResolvedRate | null {
  const own = staff.commissionRules.find((rule) => rule.kind === kind);
  if (own) return { ratePct: own.ratePct, ruleVersion: `staff:${staff.id}`, source: 'staff' };

  const rate = db
    .select()
    .from(schema.commissionRates)
    .where(
      and(
        eq(schema.commissionRates.tenantId, tenantId),
        eq(schema.commissionRates.kind, kind),
        lte(schema.commissionRates.effectiveFrom, onDate),
      ),
    )
    .orderBy(desc(schema.commissionRates.effectiveFrom))
    .get();
  if (!rate) return null;
  return { ratePct: rate.ratePct, ruleVersion: rate.version, source: 'tenant' };
}

/**
 * Rate applied to basis, in integer minor units.
 *
 * Rounded half-up at the last step and never carried as a fraction, so the sum
 * of a run's lines is the sum of what each person is owed rather than a total
 * that disagrees with its own rows by a rupee.
 */
export function commissionAmount(basisMinor: number, ratePct: number): number {
  return Math.round((basisMinor * ratePct) / 100);
}

/* ============================================================================
   Eligible transactions
   ========================================================================= */

interface EarningEvent {
  staffId: string;
  kind: CommissionKind;
  branchId: string;
  /** Net of tax and discount. Integer minor units. */
  basisMinor: number;
  refType: string;
  refId: string;
  /** Branch-local date the money was collected. Decides the rate and the
   *  period a line lands in. */
  onDate: string;
  evidence: string[];
}

/**
 * POS sales, attributed to whoever rang them up.
 *
 * A return is its own order in this system rather than an edit of the
 * original, so it arrives here as a negative basis and produces a
 * compensating entry through exactly the same path.
 */
function posEarnings(tenantId: string, from: number, to: number, branchIds: string[]): EarningEvent[] {
  const orders = db
    .select()
    .from(schema.posOrders)
    .where(
      and(
        eq(schema.posOrders.tenantId, tenantId),
        inArray(schema.posOrders.branchId, branchIds),
        gte(schema.posOrders.createdAt, from),
        lte(schema.posOrders.createdAt, to),
        // A voided order was never a sale.
        ne(schema.posOrders.state, 'voided'),
      ),
    )
    .all();

  const events: EarningEvent[] = [];
  for (const order of orders) {
    if (!order.staffId) continue;
    // Net of tax and of discount. `subtotal - discount` is the gym's revenue;
    // the tax was never theirs.
    const basisMinor = order.subtotalMinor - order.discountMinor;
    if (basisMinor === 0) continue;
    events.push({
      staffId: order.staffId,
      kind: 'sale',
      branchId: order.branchId,
      // A return order carries `kind: 'return'` and positive figures, so the
      // sign is applied here rather than trusted from the row.
      basisMinor: order.kind === 'return' ? -Math.abs(basisMinor) : basisMinor,
      refType: 'pos_order',
      refId: order.id,
      onDate: isoDate(order.createdAt, branchTimeZone(tenantId, order.branchId)),
      evidence: [
        `pos_order:${order.id}`,
        `reference:${order.reference}`,
        `state:${order.state}`,
        `kind:${order.kind}`,
      ],
    });
  }
  return events;
}

/**
 * Membership sales, attributed to whoever recorded the payment.
 *
 * The honest attribution available from this data. There is no "sold by" on a
 * membership, and inventing one by guessing at a lead owner would be worse
 * than using the person the payment record actually names.
 *
 * Only succeeded payments count, and the evidence says the payment was
 * *recorded* by a method — never that a provider settled it, because none has.
 */
function membershipEarnings(tenantId: string, from: number, to: number, branchIds: string[]): EarningEvent[] {
  const rows = db
    .select({ payment: schema.payments, invoice: schema.invoices })
    .from(schema.payments)
    .innerJoin(schema.invoices, eq(schema.invoices.id, schema.payments.invoiceId))
    .where(
      and(
        eq(schema.payments.tenantId, tenantId),
        eq(schema.payments.state, 'succeeded'),
        gte(schema.payments.createdAt, from),
        lte(schema.payments.createdAt, to),
        eq(schema.invoices.refType, 'membership'),
        inArray(schema.invoices.branchId, branchIds),
      ),
    )
    .all();

  const events: EarningEvent[] = [];
  for (const row of rows) {
    const staffId = staffIdForUser(tenantId, row.payment.recordedById);
    if (!staffId) continue;
    if (row.invoice.voided) continue;

    // The payment may be part of an invoice, so the commissionable basis is
    // the payment's share of the invoice net of tax — never the gross tender.
    const netMinor = row.invoice.subtotalMinor - row.invoice.discountMinor;
    if (netMinor <= 0 || row.invoice.totalMinor <= 0) continue;
    const basisMinor = Math.round((row.payment.amountMinor * netMinor) / row.invoice.totalMinor);
    if (basisMinor === 0) continue;

    events.push({
      staffId,
      kind: 'package',
      branchId: row.invoice.branchId,
      basisMinor,
      refType: 'payment',
      refId: row.payment.id,
      onDate: isoDate(row.payment.createdAt, branchTimeZone(tenantId, row.invoice.branchId)),
      evidence: [
        `payment:${row.payment.id}`,
        `invoice:${row.invoice.id}`,
        // Deliberately "recorded as", not "processed by". `provider` is null
        // everywhere in this system and this line must not imply otherwise.
        `recorded_as:${row.payment.method}`,
        `provider:${row.payment.provider ?? 'none'}`,
      ],
    });
  }
  return events;
}

/** `payments.recorded_by_id` is a *user*; commission is owed to a *staff*
 *  record. A user with no staff row earns nothing rather than erroring. */
function staffIdForUser(tenantId: string, userId: string | null): string | null {
  if (!userId) return null;
  return (
    db
      .select({ id: schema.staff.id })
      .from(schema.staff)
      .where(and(eq(schema.staff.tenantId, tenantId), eq(schema.staff.userId, userId)))
      .get()?.id ?? null
  );
}

/* ============================================================================
   Calculating a run
   ========================================================================= */

export interface CalculateResult {
  periodStart: string;
  periodEnd: string;
  created: number;
  /** Sources that already had a line — the idempotent no-op path. */
  alreadyAccrued: number;
  /** Eligible money that produced nothing because no rate is configured. */
  noRate: Array<{ staffId: string; kind: CommissionKind; basisMinor: number }>;
  totalMinor: number;
  lines: CommissionLine[];
}

/**
 * Accrue commission for a period.
 *
 * Idempotent: one line per (staff, kind, source transaction), enforced by a
 * partial unique index rather than by this function remembering to check. Re-
 * running a period after a late payment picks up only what is new.
 */
export function calculateCommission(
  ctx: RequestContext,
  input: { periodStart: string; periodEnd: string; branchId?: string },
): CalculateResult {
  requirePermission(ctx, 'staff.commission');
  const atMs = now();

  if (input.periodEnd < input.periodStart) throw invalid('A commission period must end on or after it starts.');

  const scope = input.branchId ? [input.branchId] : branchScope(ctx);
  if (input.branchId && !branchScope(ctx).includes(input.branchId)) throw notFound('That branch');
  if (scope.length === 0) {
    return {
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      created: 0,
      alreadyAccrued: 0,
      noRate: [],
      totalMinor: 0,
      lines: [],
    };
  }

  // Period bounds are branch-local dates; the queries need instants. Using the
  // first in-scope branch's zone keeps a single-branch run exact, and a
  // multi-branch run consistent with how Reports already bound a period.
  const tz = branchTimeZone(ctx.tenantId, scope[0] ?? null);
  const from = Date.parse(`${input.periodStart}T00:00:00Z`) - tzOffsetMs(input.periodStart, tz);
  const to = Date.parse(`${input.periodEnd}T23:59:59.999Z`) - tzOffsetMs(input.periodEnd, tz);

  const events = [
    ...posEarnings(ctx.tenantId, from, to, scope),
    ...membershipEarnings(ctx.tenantId, from, to, scope),
  ];

  const result: CalculateResult = {
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    created: 0,
    alreadyAccrued: 0,
    noRate: [],
    totalMinor: 0,
    lines: [],
  };

  const staffCache = new Map<string, typeof schema.staff.$inferSelect | null>();
  const loadStaff = (staffId: string) => {
    if (!staffCache.has(staffId)) {
      staffCache.set(
        staffId,
        db.select().from(schema.staff).where(eq(schema.staff.id, staffId)).get() ?? null,
      );
    }
    return staffCache.get(staffId)!;
  };

  transact(() => {
    for (const event of events) {
      const staff = loadStaff(event.staffId);
      if (!staff || staff.tenantId !== ctx.tenantId) continue;

      const rate = resolveRate(ctx.tenantId, staff, event.kind, event.onDate);
      if (!rate) {
        result.noRate.push({ staffId: event.staffId, kind: event.kind, basisMinor: event.basisMinor });
        continue;
      }

      const amountMinor = commissionAmount(event.basisMinor, rate.ratePct);
      if (amountMinor === 0) continue;

      const lineId = id('cml');
      try {
        db.insert(schema.commissionLines)
          .values({
            id: lineId,
            tenantId: ctx.tenantId,
            staffId: event.staffId,
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
            kind: event.kind,
            basisMinor: event.basisMinor,
            ratePct: rate.ratePct,
            amountMinor,
            ruleVersion: rate.ruleVersion,
            evidence: [...event.evidence, `rate:${rate.ratePct}%`, `rule:${rate.ruleVersion}`],
            state: 'pending',
            refType: event.refType,
            refId: event.refId,
            branchId: event.branchId,
            correctionOfLineId: null,
            correctionReason: null,
            approvedByUserId: null,
            approvedAt: null,
            paidByUserId: null,
            paidAt: null,
            paidReference: null,
            createdAt: atMs,
          })
          .run();
        result.created += 1;
        result.totalMinor += amountMinor;
      } catch (error) {
        // The unique index is the authority. A source that already has a line
        // is the expected outcome of a re-run, not a failure.
        if (String(error).includes('UNIQUE') || String(error).includes('constraint')) {
          result.alreadyAccrued += 1;
          continue;
        }
        throw error;
      }
    }

    if (result.created > 0) {
      audit(ctx, {
        action: 'commission.calculated',
        entityType: 'commission_run',
        entityId: `${input.periodStart}:${input.periodEnd}`,
        branchId: input.branchId ?? null,
        after: {
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          lines: result.created,
          totalMinor: result.totalMinor,
        },
      });
    }
  });

  result.lines = db
    .select()
    .from(schema.commissionLines)
    .where(
      and(
        eq(schema.commissionLines.tenantId, ctx.tenantId),
        eq(schema.commissionLines.periodStart, input.periodStart),
        eq(schema.commissionLines.periodEnd, input.periodEnd),
      ),
    )
    .all()
    .filter((line) => line.branchId === null || scope.includes(line.branchId));

  return result;
}

/** The UTC offset of a zone on a given local date, in milliseconds. */
function tzOffsetMs(isoDay: string, timeZone: string): number {
  const probe = Date.parse(`${isoDay}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(probe);
  const at = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return Date.UTC(at('year'), at('month') - 1, at('day'), at('hour') % 24, at('minute'), at('second')) - probe;
}

/* ============================================================================
   Approval and payment
   ========================================================================= */

function loadLineInScope(ctx: RequestContext, lineId: string): CommissionLine {
  const line = db
    .select()
    .from(schema.commissionLines)
    .where(and(eq(schema.commissionLines.id, lineId), eq(schema.commissionLines.tenantId, ctx.tenantId)))
    .get();
  if (!line) throw notFound('That commission line');
  if (line.branchId !== null && !branchScope(ctx).includes(line.branchId)) throw notFound('That commission line');
  return line;
}

export function approveCommission(ctx: RequestContext, lineIds: string[]): { approved: string[]; totalMinor: number } {
  requirePermission(ctx, 'staff.commission.approve');
  const atMs = now();
  const approved: string[] = [];
  let totalMinor = 0;

  transact(() => {
    for (const lineId of lineIds) {
      const line = loadLineInScope(ctx, lineId);
      if (line.state === 'approved') continue;
      if (line.state !== 'pending') {
        throw precondition(`A ${line.state} commission line cannot be approved.`);
      }

      db.update(schema.commissionLines)
        .set({ state: 'approved', approvedByUserId: ctx.userId, approvedAt: atMs })
        .where(eq(schema.commissionLines.id, lineId))
        .run();
      approved.push(lineId);
      totalMinor += line.amountMinor;

      audit(ctx, {
        action: 'commission.approved',
        entityType: 'commission_line',
        entityId: lineId,
        branchId: line.branchId,
        before: { state: line.state },
        after: { state: 'approved', amountMinor: line.amountMinor },
      });
    }
  });

  return { approved, totalMinor };
}

/**
 * Mark approved commission as paid.
 *
 * This moves no money. It records that a payroll run outside this system
 * settled these lines, and `paidReference` is where that run is named — which
 * is why the reference is required rather than optional.
 */
export function markCommissionPaid(
  ctx: RequestContext,
  lineIds: string[],
  reference: string,
): { paid: string[]; totalMinor: number } {
  requirePermission(ctx, 'staff.commission.approve');
  const atMs = now();
  const trimmed = reference.trim();
  if (trimmed.length < 3) throw invalid('Recording a payment needs the payroll reference it was settled under.');

  const paid: string[] = [];
  let totalMinor = 0;

  transact(() => {
    for (const lineId of lineIds) {
      const line = loadLineInScope(ctx, lineId);
      if (line.state === 'paid') continue;
      if (line.state !== 'approved') {
        throw precondition('Commission must be approved before it can be marked paid.');
      }

      db.update(schema.commissionLines)
        .set({ state: 'paid', paidByUserId: ctx.userId, paidAt: atMs, paidReference: trimmed })
        .where(eq(schema.commissionLines.id, lineId))
        .run();
      paid.push(lineId);
      totalMinor += line.amountMinor;

      audit(ctx, {
        action: 'commission.paid',
        entityType: 'commission_line',
        entityId: lineId,
        branchId: line.branchId,
        before: { state: 'approved' },
        after: { state: 'paid', reference: trimmed, amountMinor: line.amountMinor },
      });
    }
  });

  return { paid, totalMinor };
}

/**
 * Correct a commission line with a compensating entry.
 *
 * Never an edit. The original row keeps its amount, its rate and its state,
 * and a second row carries the negative — so "why did this change?" always has
 * an answer, and a line that was already paid can be clawed back without
 * pretending it was never paid.
 */
export function correctCommission(
  ctx: RequestContext,
  lineId: string,
  input: { reason: string; amountMinor?: number },
): { correctionId: string; amountMinor: number } {
  requirePermission(ctx, 'staff.commission.approve');
  const atMs = now();
  const reason = input.reason.trim();
  if (reason.length < 4) throw invalid('A correction needs a reason of at least 4 characters.');

  const line = loadLineInScope(ctx, lineId);
  if (line.correctionOfLineId !== null) throw invalid('Correct the original line, not a correction of it.');

  // Full reversal by default; a partial correction states the amount to take
  // back and may not exceed what was accrued.
  const magnitude = input.amountMinor === undefined ? Math.abs(line.amountMinor) : Math.abs(input.amountMinor);
  if (magnitude === 0) throw invalid('A correction of nothing is not a correction.');
  if (magnitude > Math.abs(line.amountMinor)) {
    throw invalid('A correction cannot take back more than the line accrued.');
  }
  const amountMinor = line.amountMinor > 0 ? -magnitude : magnitude;

  const correctionId = id('cml');

  transact(() => {
    db.insert(schema.commissionLines)
      .values({
        id: correctionId,
        tenantId: ctx.tenantId,
        staffId: line.staffId,
        periodStart: line.periodStart,
        periodEnd: line.periodEnd,
        kind: line.kind,
        basisMinor: -line.basisMinor,
        ratePct: line.ratePct,
        amountMinor,
        ruleVersion: line.ruleVersion,
        evidence: [`correction_of:${line.id}`, `reason:${reason}`],
        // A correction is settled in the same run as whatever it corrects, so
        // it starts pending and goes through the same approval.
        state: 'pending',
        refType: line.refType,
        refId: line.refId,
        branchId: line.branchId,
        correctionOfLineId: line.id,
        correctionReason: reason,
        approvedByUserId: null,
        approvedAt: null,
        paidByUserId: null,
        paidAt: null,
        paidReference: null,
        createdAt: atMs,
      })
      .run();

    // The original is marked `reversed` only for a full reversal, and even
    // then its amount is untouched — the state says "superseded", it does not
    // rewrite what was earned.
    if (magnitude === Math.abs(line.amountMinor)) {
      db.update(schema.commissionLines)
        .set({ state: 'reversed' })
        .where(eq(schema.commissionLines.id, line.id))
        .run();
    }

    audit(ctx, {
      action: 'commission.corrected',
      entityType: 'commission_line',
      entityId: line.id,
      branchId: line.branchId,
      reason,
      before: { state: line.state, amountMinor: line.amountMinor },
      after: { correctionId, amountMinor },
    });
  });

  return { correctionId, amountMinor };
}

/* ============================================================================
   Reporting
   ========================================================================= */

export interface CommissionReportQuery {
  periodStart: string;
  periodEnd: string;
  staffId?: string;
  branchId?: string;
  state?: string;
}

/** Commission by member of staff for a period. Read-only, and gated on
 *  `staff.commission` — the viewing half of the split. */
export function commissionReport(ctx: RequestContext, query: CommissionReportQuery) {
  requirePermission(ctx, 'staff.commission');
  const scope = query.branchId ? [query.branchId] : branchScope(ctx);
  if (query.branchId && !branchScope(ctx).includes(query.branchId)) throw notFound('That branch');
  if (query.staffId) loadStaffInScope(ctx, query.staffId);

  const lines = db
    .select()
    .from(schema.commissionLines)
    .where(
      and(
        eq(schema.commissionLines.tenantId, ctx.tenantId),
        gte(schema.commissionLines.periodStart, query.periodStart),
        lte(schema.commissionLines.periodEnd, query.periodEnd),
        query.staffId ? eq(schema.commissionLines.staffId, query.staffId) : undefined,
        query.state ? eq(schema.commissionLines.state, query.state) : undefined,
      ),
    )
    .orderBy(asc(schema.commissionLines.staffId), asc(schema.commissionLines.createdAt))
    .all()
    // A line with no branch predates this workflow; keep it visible to
    // whoever can see the whole tenant rather than silently dropping it.
    .filter((line) => (line.branchId === null ? true : scope.includes(line.branchId)));

  const names = new Map(
    db
      .select({ staffId: schema.staff.id, name: schema.users.name })
      .from(schema.staff)
      .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
      .where(eq(schema.staff.tenantId, ctx.tenantId))
      .all()
      .map((row) => [row.staffId, row.name]),
  );

  const byStaff = new Map<string, { staffId: string; name: string; lines: CommissionLine[] }>();
  for (const line of lines) {
    const entry = byStaff.get(line.staffId) ?? {
      staffId: line.staffId,
      name: names.get(line.staffId) ?? 'Unknown',
      lines: [],
    };
    entry.lines.push(line);
    byStaff.set(line.staffId, entry);
  }

  const sum = (rows: CommissionLine[], state?: string): number =>
    rows
      .filter((row) => (state ? row.state === state : true))
      // A reversed line's amount stays on the row as history; the money owed
      // is the correction that superseded it, which is counted on its own row.
      .filter((row) => row.state !== 'reversed')
      .reduce((total, row) => total + row.amountMinor, 0);

  return {
    periodStart: query.periodStart,
    periodEnd: query.periodEnd,
    currency: 'INR',
    staff: [...byStaff.values()].map((entry) => ({
      staffId: entry.staffId,
      name: entry.name,
      pendingMinor: sum(entry.lines, 'pending'),
      approvedMinor: sum(entry.lines, 'approved'),
      paidMinor: sum(entry.lines, 'paid'),
      totalMinor: sum(entry.lines),
      lines: entry.lines.map((line) => ({
        id: line.id,
        kind: line.kind,
        basisMinor: line.basisMinor,
        ratePct: line.ratePct,
        amountMinor: line.amountMinor,
        state: line.state,
        ruleVersion: line.ruleVersion,
        refType: line.refType,
        refId: line.refId,
        branchId: line.branchId,
        correctionOfLineId: line.correctionOfLineId,
        correctionReason: line.correctionReason,
        evidence: line.evidence,
        createdAt: line.createdAt,
      })),
    })),
    totals: {
      pendingMinor: sum(lines, 'pending'),
      approvedMinor: sum(lines, 'approved'),
      paidMinor: sum(lines, 'paid'),
      totalMinor: sum(lines),
    },
    /** Stated rather than assumed: no payment provider is involved in any of
     *  this, and marking a line paid records a payroll run elsewhere. */
    settlementNote:
      'Commission is calculated from payments recorded in this system. Marking a line paid records an external payroll settlement; no money moves here.',
  };
}

/** The rules currently in force, for the console's rules screen. */
export function commissionRules(ctx: RequestContext) {
  requirePermission(ctx, 'staff.commission');
  const today = isoDate(now(), branchTimeZone(ctx.tenantId, branchScope(ctx)[0] ?? null));

  const rates = db
    .select()
    .from(schema.commissionRates)
    .where(
      and(
        eq(schema.commissionRates.tenantId, ctx.tenantId),
        lte(schema.commissionRates.effectiveFrom, today),
      ),
    )
    .orderBy(desc(schema.commissionRates.effectiveFrom))
    .all();

  const inForce = new Map<string, (typeof rates)[number]>();
  for (const rate of rates) if (!inForce.has(rate.kind)) inForce.set(rate.kind, rate);

  return {
    kinds: COMMISSION_KINDS,
    tenantRates: [...inForce.values()].map((rate) => ({
      kind: rate.kind,
      ratePct: rate.ratePct,
      version: rate.version,
      effectiveFrom: rate.effectiveFrom,
    })),
    /** `session` has a rate but no eligible transaction source in this
     *  release. Said out loud rather than leaving a configured rate that
     *  quietly never pays. */
    unsourcedKinds: COMMISSION_KINDS.filter((kind) => kind === 'session'),
    canApprove: ctx.permissions.includes('staff.commission.approve'),
  };
}

/** Lines awaiting a decision, for the approval queue. */
export function pendingCommission(ctx: RequestContext) {
  requirePermission(ctx, 'staff.commission');
  const scope = branchScope(ctx);
  const lines = db
    .select()
    .from(schema.commissionLines)
    .where(
      and(eq(schema.commissionLines.tenantId, ctx.tenantId), eq(schema.commissionLines.state, 'pending')),
    )
    .orderBy(asc(schema.commissionLines.createdAt))
    .all()
    .filter((line) => (line.branchId === null ? true : scope.includes(line.branchId)));

  return {
    lines,
    totalMinor: lines.reduce((total, line) => total + line.amountMinor, 0),
    canApprove: ctx.permissions.includes('staff.commission.approve'),
  };
}
