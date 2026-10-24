CREATE TABLE invoice_tax_documents (
  invoice_id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  gstin TEXT,
  document TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER invoice_tax_document_no_update BEFORE UPDATE ON invoice_tax_documents BEGIN SELECT RAISE(ABORT, 'invoice tax documents are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER invoice_tax_document_no_delete BEFORE DELETE ON invoice_tax_documents BEGIN SELECT RAISE(ABORT, 'invoice tax documents are immutable'); END;
