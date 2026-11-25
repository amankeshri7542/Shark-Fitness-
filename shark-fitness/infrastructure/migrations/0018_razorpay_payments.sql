CREATE TABLE `payment_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`member_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`provider` text NOT NULL,
	`channel` text NOT NULL,
	`purpose` text NOT NULL,
	`state` text DEFAULT 'created' NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`provider_order_id` text,
	`provider_payment_id` text,
	`provider_link_id` text,
	`link_url` text,
	`expires_at` integer,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`payment_id` text,
	`failure_code` text,
	`failure_reason` text,
	`created_by_id` text NOT NULL,
	`created_by_name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`settled_at` integer,
	`last_checked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_intents_idem_uq` ON `payment_intents` (`tenant_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_intents_order_uq` ON `payment_intents` (`provider`,`provider_order_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_intents_link_uq` ON `payment_intents` (`provider`,`provider_link_id`);--> statement-breakpoint
CREATE INDEX `payment_intents_invoice_idx` ON `payment_intents` (`tenant_id`,`invoice_id`,`state`);--> statement-breakpoint
CREATE INDEX `payment_intents_state_idx` ON `payment_intents` (`state`,`updated_at`);--> statement-breakpoint
CREATE TABLE `payment_reconciliation_exceptions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`branch_id` text,
	`invoice_id` text,
	`intent_id` text,
	`provider` text NOT NULL,
	`provider_payment_id` text,
	`provider_refund_id` text,
	`kind` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`expected_minor` integer,
	`received_minor` integer,
	`currency` text,
	`detail` text NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`resolution_reason` text,
	`resolved_by_id` text,
	`resolved_by_name` text,
	`resolved_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_recon_dedupe_uq` ON `payment_reconciliation_exceptions` (`tenant_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `payment_recon_state_idx` ON `payment_reconciliation_exceptions` (`tenant_id`,`state`,`created_at`);--> statement-breakpoint
ALTER TABLE `refunds` ADD `provider` text;--> statement-breakpoint
ALTER TABLE `refunds` ADD `provider_refund_id` text;--> statement-breakpoint
ALTER TABLE `refunds` ADD `idempotency_key` text;--> statement-breakpoint
ALTER TABLE `refunds` ADD `failure_reason` text;--> statement-breakpoint
ALTER TABLE `refunds` ADD `updated_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_provider_uq` ON `refunds` (`provider`,`provider_refund_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_idem_uq` ON `refunds` (`tenant_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `payments_provider_ref_uq` ON `payments` (`provider`,`provider_ref`) WHERE "payments"."provider" = 'razorpay';