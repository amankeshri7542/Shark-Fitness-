import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * P05 additions: sellable credit packs and private media.
 *
 * Kept in their own module so the phase's schema reads as one piece, and so a
 * later merge renumbers one migration rather than untangling several.
 */

/**
 * One purchased pack (decision 11). The credits themselves live in the
 * append-only `credits` ledger: the pack's grant row is the lot, and every
 * spend, restore, revocation and expiry is a row that cites it. Credits exist
 * only once the invoice is paid in full (`allocatedAt`), in the same
 * transaction as the payment that completed it.
 */
export const creditPacks = sqliteTable(
  'credit_packs',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    branchId: text('branch_id').notNull(),
    memberId: text('member_id').notNull(),
    productId: text('product_id').notNull(),
    productName: text('product_name').notNull(),
    /** 'class' or 'pt'. */
    creditKind: text('credit_kind').notNull(),
    units: integer('units').notNull(),
    /** Days of validity counted from allocation. */
    validDays: integer('valid_days').notNull(),
    /** The invoice total, frozen; the refund unit price derives from it. */
    priceMinor: integer('price_minor').notNull(),
    invoiceId: text('invoice_id').notNull(),
    /** pending_payment → active → (partially_refunded | refunded); void. */
    state: text('state').notNull().default('pending_payment'),
    soldBy: text('sold_by').notNull(),
    allocatedAt: integer('allocated_at'),
    expiresOn: text('expires_on'),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    idemUq: uniqueIndex('credit_packs_idem_uq').on(t.tenantId, t.idempotencyKey),
    byMember: index('credit_packs_member_idx').on(t.memberId, t.createdAt),
    byInvoice: index('credit_packs_invoice_idx').on(t.invoiceId),
  }),
);

/**
 * A private file (a progress photo today). The bytes live behind the
 * `MediaStorage` port, never under a static root; this row is the only way to
 * reach them. Deletion removes the bytes and keeps the row as a tombstone
 * (`deletedAt`, `deletedReason`, the checksum), so "what was held, and when
 * was it destroyed" stays answerable.
 */
export const mediaObjects = sqliteTable(
  'media_objects',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    ownerMemberId: text('owner_member_id').notNull(),
    purpose: text('purpose').notNull(),
    storageKey: text('storage_key').notNull(),
    contentType: text('content_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: integer('created_at').notNull(),
    deletedAt: integer('deleted_at'),
    deletedReason: text('deleted_reason'),
  },
  (t) => ({
    byOwner: index('media_objects_owner_idx').on(t.ownerMemberId, t.createdAt),
    byTenantLive: index('media_objects_tenant_idx').on(t.tenantId, t.deletedAt),
  }),
);
