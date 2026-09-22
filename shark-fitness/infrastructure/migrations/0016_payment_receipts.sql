CREATE TABLE payment_receipts (
  payment_id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  issuer_name TEXT NOT NULL,
  member_name TEXT NOT NULL,
  member_no TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER payment_receipt_no_update BEFORE UPDATE ON payment_receipts BEGIN SELECT RAISE(ABORT, 'payment receipts are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER payment_receipt_no_delete BEFORE DELETE ON payment_receipts BEGIN SELECT RAISE(ABORT, 'payment receipts are immutable'); END;
