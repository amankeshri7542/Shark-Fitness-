CREATE TABLE `mfa_recovery_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mfa_recovery_codes_user_idx` ON `mfa_recovery_codes` (`user_id`);--> statement-breakpoint
CREATE TABLE `user_mfa` (
	`user_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`secret_ciphertext` text NOT NULL,
	`confirmed_at` integer,
	`last_used_step` integer,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `user_mfa_tenant_idx` ON `user_mfa` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `webhook_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`delivery_id` text NOT NULL,
	`endpoint_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`at` integer NOT NULL,
	`status_code` integer,
	`ok` integer NOT NULL,
	`latency_ms` integer NOT NULL,
	`error` text,
	`response_excerpt` text
);
--> statement-breakpoint
CREATE INDEX `webhook_attempts_delivery_idx` ON `webhook_attempts` (`delivery_id`,`attempt`);--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`endpoint_id` text NOT NULL,
	`event_id` text NOT NULL,
	`event_type` text NOT NULL,
	`body` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`lease_until` integer,
	`last_status_code` integer,
	`last_error` text,
	`replay_of` text,
	`test` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_due_idx` ON `webhook_deliveries` (`state`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_endpoint_idx` ON `webhook_deliveries` (`endpoint_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_deliveries_endpoint_event_uq` ON `webhook_deliveries` (`endpoint_id`,`event_id`) WHERE replay_of is null and test = 0;--> statement-breakpoint
CREATE TABLE `webhook_endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`url` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`events` text NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`disabled_reason` text,
	`disabled_at` integer,
	`secret_ciphertext` text NOT NULL,
	`secret_hint` text NOT NULL,
	`previous_secret_ciphertext` text,
	`previous_secret_expires_at` integer,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`cursor_seq` integer DEFAULT 0 NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `webhook_endpoints_tenant_idx` ON `webhook_endpoints` (`tenant_id`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `mfa_state` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `reauthenticated_at` integer;--> statement-breakpoint
ALTER TABLE `sessions` ADD `last_active_at` integer;