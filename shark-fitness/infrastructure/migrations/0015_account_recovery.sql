CREATE TABLE account_recoveries (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  issued_by_user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  identity_hash TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
--> statement-breakpoint
CREATE INDEX account_recoveries_user_idx ON account_recoveries (tenant_id, user_id);
