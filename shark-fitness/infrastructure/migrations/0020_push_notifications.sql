CREATE TABLE `push_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`branch_id` text,
	`category` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`notification_id` text,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`path` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`due_at` integer NOT NULL,
	`expires_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`locked_at` integer,
	`devices_sent` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`sent_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_deliveries_dedupe_uq` ON `push_deliveries` (`user_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `push_deliveries_due_idx` ON `push_deliveries` (`state`,`due_at`);--> statement-breakpoint
CREATE INDEX `push_deliveries_tenant_idx` ON `push_deliveries` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `push_deliveries_open_idx` ON `push_deliveries` (`locked_at`) WHERE state = 'sending';--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text,
	`endpoint_hash` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`last_success_at` integer,
	`last_failure_at` integer,
	`failure_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_uq` ON `push_subscriptions` (`endpoint_hash`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_user_idx` ON `push_subscriptions` (`tenant_id`,`user_id`);