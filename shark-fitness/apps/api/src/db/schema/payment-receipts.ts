import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const paymentReceipts = sqliteTable('payment_receipts', {
  paymentId: text('payment_id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  issuerName: text('issuer_name').notNull(),
  memberName: text('member_name').notNull(),
  memberNo: text('member_no').notNull(),
  createdAt: integer('created_at').notNull(),
});
