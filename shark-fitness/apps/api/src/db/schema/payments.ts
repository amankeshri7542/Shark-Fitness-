import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * One attempt to collect an invoice through a payment provider (P02).
 *
 * The row is committed *before* the provider is called and updated after, so a
 * crash or timeout between the two leaves evidence rather than a gap: an intent
 * stuck in `created` never reached the provider's answer, one in `processing`
 * has an order (or link) the provider knows about and is waiting for the
 * provider's truth. Only a verified, captured provider payment moves it to
 * `succeeded`, and that happens in the same transaction as the invoice
 * settlement (`payment_id` points at the `payments` row).
 *
 * The intent always collects an *invoice*. Whatever is being sold (an open
 * invoice, a plan purchase or renewal, and from P05 a credit pack) is invoiced
 * first by its own service; `purpose` only records why, for the timeline.
 *
 * state: created | processing | succeeded | failed | expired | superseded
 * channel: checkout | payment_link
 */
export const paymentIntents = sqliteTable(
  'payment_intents',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    branchId: text('branch_id').notNull(),
    memberId: text('member_id').notNull(),
    invoiceId: text('invoice_id').notNull(),
    provider: text('provider').notNull(),
    channel: text('channel').notNull(),
    purpose: text('purpose').notNull(),
    state: text('state').notNull().default('created'),
    amountMinor: integer('amount_minor').notNull(),
    currency: text('currency').notNull(),
    providerOrderId: text('provider_order_id'),
    providerPaymentId: text('provider_payment_id'),
    providerLinkId: text('provider_link_id'),
    linkUrl: text('link_url'),
    expiresAt: integer('expires_at'),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    /** The settled `payments` row, once there is one. */
    paymentId: text('payment_id'),
    failureCode: text('failure_code'),
    failureReason: text('failure_reason'),
    createdById: text('created_by_id').notNull(),
    createdByName: text('created_by_name').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    settledAt: integer('settled_at'),
    lastCheckedAt: integer('last_checked_at'),
  },
  (t) => ({
    idemUq: uniqueIndex('payment_intents_idem_uq').on(t.tenantId, t.idempotencyKey),
    orderUq: uniqueIndex('payment_intents_order_uq').on(t.provider, t.providerOrderId),
    linkUq: uniqueIndex('payment_intents_link_uq').on(t.provider, t.providerLinkId),
    byInvoice: index('payment_intents_invoice_idx').on(t.tenantId, t.invoiceId, t.state),
    byState: index('payment_intents_state_idx').on(t.state, t.updatedAt),
  }),
);

/**
 * Something the provider says happened that the books could not simply
 * accept: an amount or currency that does not match the intent, a captured
 * payment for an invoice that was already settled at the desk, a payment or
 * refund nobody here started. Money is never moved to make these go away;
 * staff resolve or ignore each one with a reason, and that is audited.
 *
 * kind: amount_mismatch | currency_mismatch | invoice_already_settled |
 *       unmatched_payment | refund_outside_console
 * state: open | resolved | ignored
 */
export const paymentReconciliationExceptions = sqliteTable(
  'payment_reconciliation_exceptions',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    branchId: text('branch_id'),
    invoiceId: text('invoice_id'),
    intentId: text('intent_id'),
    provider: text('provider').notNull(),
    providerPaymentId: text('provider_payment_id'),
    providerRefundId: text('provider_refund_id'),
    kind: text('kind').notNull(),
    /** One exception per provider object and kind, however often it is seen. */
    dedupeKey: text('dedupe_key').notNull(),
    expectedMinor: integer('expected_minor'),
    receivedMinor: integer('received_minor'),
    currency: text('currency'),
    detail: text('detail').notNull(),
    state: text('state').notNull().default('open'),
    resolutionReason: text('resolution_reason'),
    resolvedById: text('resolved_by_id'),
    resolvedByName: text('resolved_by_name'),
    resolvedAt: integer('resolved_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    dedupeUq: uniqueIndex('payment_recon_dedupe_uq').on(t.tenantId, t.dedupeKey),
    byState: index('payment_recon_state_idx').on(t.tenantId, t.state, t.createdAt),
  }),
);
