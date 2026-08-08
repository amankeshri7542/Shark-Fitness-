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

export const retailProducts = sqliteTable(
  'retail_products',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    name: text('name').notNull(),
    sku: text('sku').notNull(),
    barcode: text('barcode'),
    category: text('category').notNull(),
    priceMinor: integer('price_minor').notNull(),
    costMinor: integer('cost_minor').notNull(),
    taxRateBp: integer('tax_rate_bp').notNull().default(1800),
    reorderAt: integer('reorder_at').notNull().default(5),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({ skuUq: uniqueIndex('retail_sku_uq').on(t.tenantId, t.sku) }),
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
    taxMinor: integer('tax_minor').notNull(),
    totalMinor: integer('total_minor').notNull(),
    state: text('state').notNull().default('paid'),
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
    totalMinor: integer('total_minor').notNull(),
  },
  (t) => ({ byOrder: index('pos_lines_idx').on(t.orderId) }),
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
  },
  (t) => ({ byState: index('tickets_state_idx').on(t.tenantId, t.state, t.slaDueAt) }),
);

export const commissionRates = sqliteTable('commission_rates', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  kind: text('kind').notNull(),
  ratePct: real('rate_pct').notNull(),
  version: text('version').notNull(),
  effectiveFrom: text('effective_from').notNull(),
});
