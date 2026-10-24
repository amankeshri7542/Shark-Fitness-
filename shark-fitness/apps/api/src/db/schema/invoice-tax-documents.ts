import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Who issued an invoice and to whom, frozen when it was raised.
 *
 * A tax invoice must keep the supplier's GSTIN, address and state as they were
 * on the day of supply, so a later settings change cannot re-issue it under
 * different details. Immutable by trigger (migration 0017), like
 * `payment_receipts`.
 */
export const invoiceTaxDocuments = sqliteTable('invoice_tax_documents', {
  invoiceId: text('invoice_id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  /** `gst_tax_invoice` when a valid GSTIN was configured at issuance, else `invoice`. */
  kind: text('kind').notNull(),
  gstin: text('gstin'),
  /** `TaxDocumentSnapshot` in services/tax-invoice.ts. */
  document: text('document', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  createdAt: integer('created_at').notNull(),
});
