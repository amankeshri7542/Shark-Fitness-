import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/* ——— Billing ——————————————————————————————————————————————— */

export const invoices = sqliteTable(
  'invoices',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    branchId: text('branch_id').notNull(),
    memberId: text('member_id').notNull(),
    number: text('number').notNull(),
    state: text('state').notNull().default('open'),
    issuedOn: text('issued_on').notNull(),
    dueOn: text('due_on').notNull(),
    currency: text('currency').notNull().default('INR'),
    subtotalMinor: integer('subtotal_minor').notNull(),
    discountMinor: integer('discount_minor').notNull().default(0),
    taxMinor: integer('tax_minor').notNull(),
    totalMinor: integer('total_minor').notNull(),
    paidMinor: integer('paid_minor').notNull().default(0),
    refundedMinor: integer('refunded_minor').notNull().default(0),
    voided: integer('voided', { mode: 'boolean' }).notNull().default(false),
    voidReason: text('void_reason'),
    refType: text('ref_type'),
    refId: text('ref_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    numberUq: uniqueIndex('invoices_number_uq').on(t.tenantId, t.number),
    byMember: index('invoices_member_idx').on(t.memberId, t.state),
    byState: index('invoices_tenant_state_idx').on(t.tenantId, t.state, t.dueOn),
  }),
);

/** Immutable once the invoice leaves draft. Corrections are credit notes. */
export const invoiceLines = sqliteTable(
  'invoice_lines',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    invoiceId: text('invoice_id').notNull(),
    description: text('description').notNull(),
    quantity: integer('quantity').notNull().default(1),
    unitMinor: integer('unit_minor').notNull(),
    discountMinor: integer('discount_minor').notNull().default(0),
    taxRateBp: integer('tax_rate_bp').notNull(),
    taxMinor: integer('tax_minor').notNull(),
    totalMinor: integer('total_minor').notNull(),
    productId: text('product_id'),
  },
  (t) => ({ byInvoice: index('invoice_lines_idx').on(t.invoiceId) }),
);

export const payments = sqliteTable(
  'payments',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    branchId: text('branch_id'),
    invoiceId: text('invoice_id'),
    memberId: text('member_id').notNull(),
    method: text('method').notNull(),
    state: text('state').notNull().default('created'),
    amountMinor: integer('amount_minor').notNull(),
    currency: text('currency').notNull().default('INR'),
    provider: text('provider'),
    providerRef: text('provider_ref'),
    /** Unique per tenant. Two staff recording the same cash payment collide. */
    idempotencyKey: text('idempotency_key').notNull(),
    recordedById: text('recorded_by_id'),
    recordedByName: text('recorded_by_name'),
    failureReason: text('failure_reason'),
    note: text('note'),
    createdAt: integer('created_at').notNull(),
    settledAt: integer('settled_at'),
  },
  (t) => ({
    idemUq: uniqueIndex('payments_idem_uq').on(t.tenantId, t.idempotencyKey),
    byInvoice: index('payments_invoice_idx').on(t.invoiceId),
    byMember: index('payments_member_idx').on(t.memberId, t.createdAt),
  }),
);

export const refunds = sqliteTable(
  'refunds',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    paymentId: text('payment_id').notNull(),
    amountMinor: integer('amount_minor').notNull(),
    reason: text('reason').notNull(),
    state: text('state').notNull().default('succeeded'),
    /** Reversing entitlements is a separate decision from refunding money. */
    entitlementReversed: integer('entitlement_reversed', { mode: 'boolean' }).notNull().default(false),
    actorName: text('actor_name').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({ byPayment: index('refunds_payment_idx').on(t.paymentId) }),
);

/** Provider events are immutable inputs. Derived payment state is recomputed
 *  from them idempotently, so duplicate or out-of-order delivery is harmless. */
export const providerEvents = sqliteTable(
  'provider_events',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    type: text('type').notNull(),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    signatureOk: integer('signature_ok', { mode: 'boolean' }).notNull(),
    receivedAt: integer('received_at').notNull(),
    processedAt: integer('processed_at'),
    processingError: text('processing_error'),
  },
  (t) => ({ eventUq: uniqueIndex('provider_events_uq').on(t.provider, t.providerEventId) }),
);

export const dunningAttempts = sqliteTable(
  'dunning_attempts',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    invoiceId: text('invoice_id').notNull(),
    attempt: integer('attempt').notNull(),
    channel: text('channel').notNull(),
    scheduledFor: integer('scheduled_for').notNull(),
    state: text('state').notNull().default('scheduled'),
    sentAt: integer('sent_at'),
    stopReason: text('stop_reason'),
  },
  (t) => ({ byInvoice: index('dunning_invoice_idx').on(t.invoiceId, t.attempt) }),
);

/* ——— Attendance ——————————————————————————————————————————— */

export const accessTokens = sqliteTable(
  'access_tokens',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    memberId: text('member_id').notNull(),
    seed: text('seed').notNull(),
    issuedAt: integer('issued_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (t) => ({ byMember: index('access_tokens_member_idx').on(t.memberId) }),
);

/** Burnt rotation windows. A replayed screenshot lands here and is refused. */
export const usedAccessWindows = sqliteTable(
  'used_access_windows',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    memberId: text('member_id').notNull(),
    window: integer('window').notNull(),
    usedAt: integer('used_at').notNull(),
  },
  (t) => ({ uq: uniqueIndex('used_windows_uq').on(t.memberId, t.window) }),
);

export const checkIns = sqliteTable(
  'check_ins',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    branchId: text('branch_id').notNull(),
    memberId: text('member_id'),
    method: text('method').notNull(),
    decision: text('decision').notNull(),
    enteredAt: integer('entered_at').notNull(),
    exitedAt: integer('exited_at'),
    autoClosed: integer('auto_closed', { mode: 'boolean' }).notNull().default(false),
    overrideById: text('override_by_id'),
    overrideByName: text('override_by_name'),
    overrideReason: text('override_reason'),
    visitNumber: integer('visit_number'),
  },
  (t) => ({
    byBranchTime: index('checkins_branch_time_idx').on(t.branchId, t.enteredAt),
    byMember: index('checkins_member_idx').on(t.memberId, t.enteredAt),
    openSessions: index('checkins_open_idx').on(t.branchId, t.exitedAt),
  }),
);

/* ——— Schedule ————————————————————————————————————————————— */

export const classTypes = sqliteTable('class_types', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  name: text('name').notNull(),
  category: text('category').notNull(),
  description: text('description').notNull().default(''),
  durationMin: integer('duration_min').notNull(),
  intensity: text('intensity').notNull().default('moderate'),
  createdAt: integer('created_at').notNull(),
});

export const rooms = sqliteTable('rooms', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  branchId: text('branch_id').notNull(),
  name: text('name').notNull(),
  capacity: integer('capacity').notNull(),
});

export const classSessions = sqliteTable(
  'class_sessions',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    branchId: text('branch_id').notNull(),
    classTypeId: text('class_type_id').notNull(),
    roomId: text('room_id'),
    trainerId: text('trainer_id'),
    seriesId: text('series_id'),
    startsAt: integer('starts_at').notNull(),
    endsAt: integer('ends_at').notNull(),
    capacity: integer('capacity').notNull(),
    /** Denormalised for the last-seat claim. Only ever changed inside the
     *  booking transaction, which is the single concurrency authority. */
    booked: integer('booked').notNull().default(0),
    state: text('state').notNull().default('scheduled'),
    bookingOpensAt: integer('booking_opens_at'),
    cancelDeadlineAt: integer('cancel_deadline_at'),
    creditsRequired: integer('credits_required').notNull().default(0),
    dropInPriceMinor: integer('drop_in_price_minor'),
    lateCancelFeeMinor: integer('late_cancel_fee_minor').notNull().default(0),
    waitlistEnabled: integer('waitlist_enabled', { mode: 'boolean' }).notNull().default(true),
    cancelledReason: text('cancelled_reason'),
    substituteFor: text('substitute_for'),
    notes: text('notes'),
    version: integer('version').notNull().default(1),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    byBranchTime: index('sessions_branch_time_idx').on(t.branchId, t.startsAt),
    byTrainer: index('sessions_trainer_idx').on(t.trainerId, t.startsAt),
  }),
);

export const bookings = sqliteTable(
  'bookings',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    sessionId: text('session_id').notNull(),
    memberId: text('member_id').notNull(),
    state: text('state').notNull().default('confirmed'),
    seatNo: integer('seat_no'),
    bookedAt: integer('booked_at').notNull(),
    cancelledAt: integer('cancelled_at'),
    heldUntil: integer('held_until'),
    creditsUsed: integer('credits_used').notNull().default(0),
    chargeMinor: integer('charge_minor').notNull().default(0),
    cameFromWaitlist: integer('came_from_waitlist', { mode: 'boolean' }).notNull().default(false),
    idempotencyKey: text('idempotency_key').notNull(),
    attendedAt: integer('attended_at'),
  },
  (t) => ({
    idemUq: uniqueIndex('bookings_idem_uq').on(t.tenantId, t.idempotencyKey),
    /** One live booking per member per session. Enforced by a partial index
     *  created in the migration, since Drizzle's builder has no WHERE clause. */
    bySession: index('bookings_session_idx').on(t.sessionId, t.state),
    byMember: index('bookings_member_idx').on(t.memberId, t.bookedAt),
  }),
);

export const waitlistEntries = sqliteTable(
  'waitlist_entries',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    sessionId: text('session_id').notNull(),
    memberId: text('member_id').notNull(),
    position: integer('position').notNull(),
    state: text('state').notNull().default('waiting'),
    joinedAt: integer('joined_at').notNull(),
    offeredAt: integer('offered_at'),
    offerExpiresAt: integer('offer_expires_at'),
    resolvedAt: integer('resolved_at'),
  },
  (t) => ({
    uq: uniqueIndex('waitlist_uq').on(t.sessionId, t.memberId),
    bySession: index('waitlist_session_idx').on(t.sessionId, t.position),
  }),
);

export const appointments = sqliteTable(
  'appointments',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    branchId: text('branch_id').notNull(),
    memberId: text('member_id').notNull(),
    trainerId: text('trainer_id').notNull(),
    kind: text('kind').notNull(),
    startsAt: integer('starts_at').notNull(),
    endsAt: integer('ends_at').notNull(),
    state: text('state').notNull().default('confirmed'),
    creditsUsed: integer('credits_used').notNull().default(0),
    notes: text('notes'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({ byTrainer: index('appointments_trainer_idx').on(t.trainerId, t.startsAt) }),
);

/* ——— Store and facility ——————————————————————————————————— */

/**
 * Phase 7 (PF-POS) additions.
 *
 * The implementation plan claimed the store needed no migration. It was wrong:
 * variants, suppliers, mixed tender, returns, inter-branch transfers and
 * margin reporting each have a SHALL clause with nowhere to live. What follows
 * is the smallest set of additions that makes those honest.
 *
 * The stock-keeping unit stays `retail_products`. That row already carries the
 * SKU, barcode, price and cost, and the ledger already points at it, so making
 * it the variant costs no data migration; `retail_product_groups` is the
 * parent that turns "Shark Tee" into S/M/L. Every column added below is
 * nullable or defaulted, so the migration is safe against a seeded database.
 */

export const suppliers = sqliteTable(
  'suppliers',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    name: text('name').notNull(),
    contactName: text('contact_name').notNull().default(''),
    email: text('email').notNull().default(''),
    phone: text('phone').notNull().default(''),
    leadTimeDays: integer('lead_time_days').notNull().default(7),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({ nameUq: uniqueIndex('supplier_name_uq').on(t.tenantId, t.name) }),
);

/** The sellable thing a customer names ("Shark Tee"); its variants are rows in
 *  `retail_products` (PF-POS-001). */
export const retailProductGroups = sqliteTable(
  'retail_product_groups',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    name: text('name').notNull(),
    category: text('category').notNull(),
    supplierId: text('supplier_id'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({ byTenant: index('retail_group_idx').on(t.tenantId, t.name) }),
);


export const retailProducts = sqliteTable(
  'retail_products',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    name: text('name').notNull(),
    sku: text('sku').notNull(),
    barcode: text('barcode'),
    category: text('category').notNull(),
    /** Parent group and the label that distinguishes this variant within it. */
    groupId: text('group_id'),
    variantName: text('variant_name').notNull().default(''),
    supplierId: text('supplier_id'),
    priceMinor: integer('price_minor').notNull(),
    costMinor: integer('cost_minor').notNull(),
    taxRateBp: integer('tax_rate_bp').notNull().default(1800),
    reorderAt: integer('reorder_at').notNull().default(5),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    skuUq: uniqueIndex('retail_sku_uq').on(t.tenantId, t.sku),
    // Partial: many products legitimately have no barcode, but a barcode that
    // exists must scan to exactly one SKU (PF-POS edge case).
    barcodeUq: uniqueIndex('retail_barcode_uq')
      .on(t.tenantId, t.barcode)
      .where(sql`barcode is not null`),
  }),
);

/** Immutable ledger. Stock on hand is the sum of deltas, never a stored
 *  counter someone can drift (PF-POS-003). */
export const stockLedger = sqliteTable(
  'stock_ledger',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    branchId: text('branch_id').notNull(),
    productId: text('product_id').notNull(),
    delta: integer('delta').notNull(),
    reason: text('reason').notNull(),
    refType: text('ref_type'),
    refId: text('ref_id'),
    actorName: text('actor_name').notNull(),
    note: text('note'),
    /** What a unit cost on the way in. Only set on inbound movements; the
     *  weighted average of these is what stock is worth (PF-POS-006). */
    unitCostMinor: integer('unit_cost_minor'),
    /** Set only when the tenant policy allowed this movement to drive stock
     *  negative. The reason is mandatory in that case (PF-POS-004). */
    negativeOverride: integer('negative_override', { mode: 'boolean' }).notNull().default(false),
    overrideReason: text('override_reason'),
    at: integer('at').notNull(),
  },
  (t) => ({ byProduct: index('stock_product_idx').on(t.productId, t.branchId, t.at) }),
);

export const posOrders = sqliteTable(
  'pos_orders',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    branchId: text('branch_id').notNull(),
    reference: text('reference').notNull(),
    memberId: text('member_id'),
    subtotalMinor: integer('subtotal_minor').notNull(),
    discountMinor: integer('discount_minor').notNull().default(0),
    taxMinor: integer('tax_minor').notNull(),
    totalMinor: integer('total_minor').notNull(),
    /** `paid` | `voided` | `returned` | `partially_returned` */
    state: text('state').notNull().default('paid'),
    /** `sale` | `return`. A return is its own order pointing at the original,
     *  never an edit of it (PF-POS-002). */
    kind: text('kind').notNull().default('sale'),
    returnOfOrderId: text('return_of_order_id'),
    voidReason: text('void_reason'),
    voidedAt: integer('voided_at'),
    staffId: text('staff_id'),
    staffName: text('staff_name').notNull(),
    invoiceId: text('invoice_id'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({ byBranch: index('pos_branch_idx').on(t.branchId, t.createdAt) }),
);

export const posOrderLines = sqliteTable(
  'pos_order_lines',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    orderId: text('order_id').notNull(),
    productId: text('product_id').notNull(),
    name: text('name').notNull(),
    quantity: integer('quantity').notNull(),
    unitMinor: integer('unit_minor').notNull(),
    /** Tax is computed per line and then summed, never on the order total. */
    taxRateBp: integer('tax_rate_bp').notNull().default(0),
    taxMinor: integer('tax_minor').notNull().default(0),
    discountMinor: integer('discount_minor').notNull().default(0),
    /** Unit cost at the moment of sale. Margin must not move when someone
     *  edits the product's cost later (PF-POS-006). */
    unitCostMinor: integer('unit_cost_minor').notNull().default(0),
    quantityReturned: integer('quantity_returned').notNull().default(0),
    totalMinor: integer('total_minor').notNull(),
  },
  (t) => ({ byOrder: index('pos_lines_idx').on(t.orderId) }),
);

/** One row per tender. A sale settled half in cash and half on a card is two
 *  rows summing to the order total (PF-POS-002). */
export const posPayments = sqliteTable(
  'pos_payments',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    orderId: text('order_id').notNull(),
    /** `cash` | `card` | `upi` | `account` */
    method: text('method').notNull(),
    amountMinor: integer('amount_minor').notNull(),
    reference: text('reference').notNull().default(''),
    at: integer('at').notNull(),
  },
  (t) => ({ byOrder: index('pos_payments_idx').on(t.orderId) }),
);

/**
 * Stock in motion between branches (PF-POS-005).
 *
 * This cannot be expressed by the ledger alone: dispatched-but-not-received
 * stock has left one branch and not yet arrived at the other, and something
 * has to own that interval. Dispatch writes the outbound ledger row, receipt
 * writes the inbound one, so the ledger stays the only source of on-hand.
 */
export const stockTransfers = sqliteTable(
  'stock_transfers',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    reference: text('reference').notNull(),
    fromBranchId: text('from_branch_id').notNull(),
    toBranchId: text('to_branch_id').notNull(),
    /** `draft` | `dispatched` | `received` | `cancelled` */
    state: text('state').notNull().default('draft'),
    note: text('note'),
    createdBy: text('created_by').notNull().default(''),
    dispatchedAt: integer('dispatched_at'),
    dispatchedBy: text('dispatched_by'),
    receivedAt: integer('received_at'),
    receivedBy: text('received_by'),
    cancelledAt: integer('cancelled_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({ byBranch: index('stock_transfer_idx').on(t.tenantId, t.state, t.createdAt) }),
);

export const stockTransferLines = sqliteTable(
  'stock_transfer_lines',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    transferId: text('transfer_id').notNull(),
    productId: text('product_id').notNull(),
    quantity: integer('quantity').notNull(),
    /** Receipt may be short — the shortfall is shrinkage, not a silent loss. */
    quantityReceived: integer('quantity_received').notNull().default(0),
    unitCostMinor: integer('unit_cost_minor').notNull().default(0),
  },
  (t) => ({ byTransfer: index('stock_transfer_lines_idx').on(t.transferId) }),
);

export const equipment = sqliteTable(
  'equipment',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    branchId: text('branch_id').notNull(),
    name: text('name').notNull(),
    assetTag: text('asset_tag').notNull(),
    area: text('area').notNull(),
    model: text('model').notNull().default(''),
    serial: text('serial').notNull().default(''),
    vendor: text('vendor').notNull().default(''),
    warrantyUntil: text('warranty_until'),
    status: text('status').notNull().default('available'),
    lastServicedOn: text('last_serviced_on'),
    serviceIntervalDays: integer('service_interval_days').notNull().default(90),
    /** Scanning this opens the right exercise with last-used settings. */
    linkedExerciseId: text('linked_exercise_id'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({ tagUq: uniqueIndex('equipment_tag_uq').on(t.tenantId, t.assetTag) }),
);

export const workOrders = sqliteTable(
  'work_orders',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    branchId: text('branch_id').notNull(),
    reference: text('reference').notNull(),
    equipmentId: text('equipment_id'),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    severity: text('severity').notNull().default('medium'),
    state: text('state').notNull().default('open'),
    reportedById: text('reported_by_id'),
    reportedByName: text('reported_by_name').notNull(),
    reportedByKind: text('reported_by_kind').notNull().default('staff'),
    assigneeId: text('assignee_id'),
    costMinor: integer('cost_minor').notNull().default(0),
    duplicateOfId: text('duplicate_of_id'),
    openedAt: integer('opened_at').notNull(),
    closedAt: integer('closed_at'),
  },
  (t) => ({ byBranch: index('work_orders_branch_idx').on(t.branchId, t.state) }),
);

export const facilityTasks = sqliteTable(
  'facility_tasks',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    branchId: text('branch_id').notNull(),
    title: text('title').notNull(),
    cadence: text('cadence').notNull(),
    nextDueAt: integer('next_due_at').notNull(),
    assigneeId: text('assignee_id'),
    state: text('state').notNull().default('open'),
    checklist: text('checklist', { mode: 'json' }).$type<string[]>().notNull(),
    lastCompletedAt: integer('last_completed_at'),
  },
  (t) => ({ byDue: index('facility_tasks_due_idx').on(t.branchId, t.nextDueAt) }),
);

export const tickets = sqliteTable(
  'tickets',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    branchId: text('branch_id'),
    memberId: text('member_id'),
    reference: text('reference').notNull(),
    category: text('category').notNull(),
    subject: text('subject').notNull(),
    priority: text('priority').notNull().default('normal'),
    state: text('state').notNull().default('open'),
    assigneeId: text('assignee_id'),
    slaDueAt: integer('sla_due_at'),
    resolution: text('resolution'),
    /** Anonymous reports keep the member link out of the staff view. */
    anonymous: integer('anonymous', { mode: 'boolean' }).notNull().default(false),
    escalated: integer('escalated', { mode: 'boolean' }).notNull().default(false),
    openedAt: integer('opened_at').notNull(),
    lastUpdateAt: integer('last_update_at').notNull(),
    closedAt: integer('closed_at'),

    /* ——— Phase 9 (PF-SUP). All additive and nullable. ——— */

    /**
     * When a human first answered. The SLA a support desk is actually judged on
     * is time-to-first-reply, and it is a fact about the past: once set it never
     * moves, so a ticket that was answered in twenty minutes cannot later be
     * reported as breaching because it stayed open for a week.
     */
    firstResponseAt: integer('first_response_at'),
    /** Set alongside `slaDueAt` so a later policy change cannot silently
     *  restate what was promised at the time. */
    slaResponseMinutes: integer('sla_response_minutes'),
    resolvedAt: integer('resolved_at'),
    resolvedBy: text('resolved_by'),
    /** PF-SUP-006. Escalation is a recorded act with an author and a reason,
     *  not a boolean somebody flipped. */
    escalatedAt: integer('escalated_at'),
    escalatedBy: text('escalated_by'),
    escalationReason: text('escalation_reason'),
    /** How many times this ticket came back. A reopened ticket is the same
     *  dispute, so it keeps its reference and its history. */
    reopenCount: integer('reopen_count').notNull().default(0),
    /** PF-SUP-005. Set by a human; suppresses every automated outreach path. */
    vulnerabilityFlag: integer('vulnerability_flag', { mode: 'boolean' }).notNull().default(false),
    /** Safety categories the member's own words tripped, from `scanForSafety`. */
    safetyCategories: text('safety_categories', { mode: 'json' }).$type<string[]>(),
  },
  (t) => ({
    byState: index('tickets_state_idx').on(t.tenantId, t.state, t.slaDueAt),
    byAssignee: index('tickets_assignee_idx').on(t.tenantId, t.assigneeId, t.state),
    byMember: index('tickets_member_idx').on(t.tenantId, t.memberId),
  }),
);

/**
 * The ticket's own timeline — PF-SUP-006.
 *
 * Append-only, enforced by `BEFORE UPDATE`/`BEFORE DELETE` triggers in
 * `migrate.ts`, exactly like `audit_log`, `xp_ledger` and `stock_ledger`.
 *
 * This is deliberately *not* the audit log. `audit_log` is the tenant's legal
 * record and reading it needs `audit.view`, which reception and branch managers
 * do not hold — yet they are the people who handle complaints and who a dispute
 * will be argued with. A record nobody involved may read is not much of a
 * record, so the ticket carries its own immutable history at the permission
 * level of the ticket. Both are written; neither can be edited.
 */
export const ticketEvents = sqliteTable(
  'ticket_events',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    ticketId: text('ticket_id').notNull(),
    /** opened · assigned · priority_changed · state_changed · replied ·
     *  internal_note · escalated · resolved · reopened · closed · risk_linked */
    kind: text('kind').notNull(),
    actorId: text('actor_id'),
    actorName: text('actor_name').notNull(),
    actorRole: text('actor_role').notNull(),
    /** One plain sentence, already written for a human to read. */
    summary: text('summary').notNull(),
    /** Structured before/after for anything a dispute might turn on. */
    detail: text('detail', { mode: 'json' }).$type<Record<string, unknown>>(),
    /** Set when this event is a member-visible reply, so the timeline and the
     *  conversation can never tell two different stories about one message. */
    messageId: text('message_id'),
    at: integer('at').notNull(),
  },
  (t) => ({ byTicket: index('ticket_events_ticket_idx').on(t.ticketId, t.at) }),
);

/**
 * Transactional feedback — PF-SUP-002.
 *
 * One table for NPS, CSAT, class ratings, trainer ratings, facility comments
 * and cancellation reasons, because they are the same shape (a subject, a
 * score, some words, an author who may wish to stay unnamed) and splitting
 * them into five would make "what is this branch's CSAT" a five-way union.
 *
 * `anonymous` is configurable per submission and is honoured by *omission*, not
 * by masking: an anonymous row carries no `member_id` at all, so there is
 * nothing to leak and nothing to join back.
 */
export const feedback = sqliteTable(
  'feedback',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    branchId: text('branch_id'),
    /** Null when anonymous. Not "hidden" — absent. */
    memberId: text('member_id'),
    /** nps · csat · class · trainer · facility · cancellation */
    kind: text('kind').notNull(),
    /** 0–10 for NPS, 1–5 for CSAT and ratings, null for a reason-only row. */
    score: integer('score'),
    comment: text('comment').notNull().default(''),
    anonymous: integer('anonymous', { mode: 'boolean' }).notNull().default(false),
    /** What it is about: class_session · staff · membership · branch. */
    subjectType: text('subject_type'),
    subjectId: text('subject_id'),
    subjectLabel: text('subject_label'),
    /** Set when a poor score was turned into a ticket, so the two are one
     *  story rather than a complaint filed twice. */
    ticketId: text('ticket_id'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    byKind: index('feedback_kind_idx').on(t.tenantId, t.kind, t.createdAt),
    byBranch: index('feedback_branch_idx').on(t.tenantId, t.branchId, t.createdAt),
  }),
);

/**
 * Staff intervention tasks — PF-SUP-004.
 *
 * The risk score that prompted one is copied onto the row at creation. Risk is
 * recomputed live from the ledgers on every read, so without that snapshot
 * "did contacting people at 71 work?" becomes unanswerable the moment their
 * score moves — which is the whole of effectiveness tracking.
 */
export const interventions = sqliteTable(
  'interventions',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    branchId: text('branch_id').notNull(),
    memberId: text('member_id').notNull(),
    /** Set when the intervention came out of a complaint rather than a score. */
    ticketId: text('ticket_id'),
    /** Frozen at creation — see above. */
    riskScoreAtCreation: integer('risk_score_at_creation').notNull(),
    riskBandAtCreation: text('risk_band_at_creation').notNull(),
    riskReasonsAtCreation: text('risk_reasons_at_creation', { mode: 'json' })
      .$type<Array<{ code: string; label: string; points: number }>>()
      .notNull(),
    /** What the engine suggested, kept even when staff chose otherwise — the
     *  disagreement is the signal worth measuring. */
    recommendedAction: text('recommended_action').notNull(),
    /** call · coach_checkin · offer_review · visit_invite · no_action */
    action: text('action').notNull(),
    note: text('note').notNull().default(''),
    assigneeId: text('assignee_id'),
    assigneeName: text('assignee_name'),
    dueAt: integer('due_at').notNull(),
    /** open · done · dismissed */
    state: text('state').notNull().default('open'),
    /** retained · churned · no_contact · false_positive */
    outcome: text('outcome'),
    outcomeNote: text('outcome_note'),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at').notNull(),
    completedAt: integer('completed_at'),
  },
  (t) => ({
    byMember: index('interventions_member_idx').on(t.tenantId, t.memberId, t.createdAt),
    byState: index('interventions_state_idx').on(t.tenantId, t.state, t.dueAt),
  }),
);

export const commissionRates = sqliteTable('commission_rates', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  kind: text('kind').notNull(),
  ratePct: real('rate_pct').notNull(),
  version: text('version').notNull(),
  effectiveFrom: text('effective_from').notNull(),
});
