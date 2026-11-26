CREATE TABLE `credit_packs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`member_id` text NOT NULL,
	`product_id` text NOT NULL,
	`product_name` text NOT NULL,
	`credit_kind` text NOT NULL,
	`units` integer NOT NULL,
	`valid_days` integer NOT NULL,
	`price_minor` integer NOT NULL,
	`invoice_id` text NOT NULL,
	`state` text DEFAULT 'pending_payment' NOT NULL,
	`sold_by` text NOT NULL,
	`allocated_at` integer,
	`expires_on` text,
	`idempotency_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credit_packs_idem_uq` ON `credit_packs` (`tenant_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `credit_packs_member_idx` ON `credit_packs` (`member_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `credit_packs_invoice_idx` ON `credit_packs` (`invoice_id`);--> statement-breakpoint
CREATE TABLE `media_objects` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`owner_member_id` text NOT NULL,
	`purpose` text NOT NULL,
	`storage_key` text NOT NULL,
	`content_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`sha256` text NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	`deleted_reason` text
);
--> statement-breakpoint
CREATE INDEX `media_objects_owner_idx` ON `media_objects` (`owner_member_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `media_objects_tenant_idx` ON `media_objects` (`tenant_id`,`deleted_at`);--> statement-breakpoint
ALTER TABLE `credits` ADD `lot_id` text;--> statement-breakpoint
ALTER TABLE `credits` ADD `pack_id` text;--> statement-breakpoint
CREATE INDEX `credits_lot_idx` ON `credits` (`lot_id`);--> statement-breakpoint
CREATE INDEX `credits_ref_idx` ON `credits` (`ref_type`,`ref_id`);--> statement-breakpoint
ALTER TABLE `progress_photos` ADD `media_id` text;--> statement-breakpoint
ALTER TABLE `progress_photos` ADD `consent_version` text;--> statement-breakpoint
ALTER TABLE `progress_photos` ADD `delete_after` integer;