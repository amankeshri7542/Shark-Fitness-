import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const accountRecoveries = sqliteTable('account_recoveries', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  userId: text('user_id').notNull(),
  issuedByUserId: text('issued_by_user_id').notNull(),
  tokenHash: text('token_hash').notNull(),
  identityHash: text('identity_hash').notNull(),
  reason: text('reason').notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  consumedAt: integer('consumed_at'),
}, (t) => ({ byUser: index('account_recoveries_user_idx').on(t.tenantId, t.userId) }));
