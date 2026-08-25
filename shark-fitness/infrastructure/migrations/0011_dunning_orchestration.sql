ALTER TABLE `dunning_attempts` ADD `retry_submitted` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `dunning_attempts` ADD `retry_outcome` text;--> statement-breakpoint
ALTER TABLE `dunning_attempts` ADD `provider_ref` text;--> statement-breakpoint
ALTER TABLE `dunning_attempts` ADD `notification_id` text;--> statement-breakpoint
ALTER TABLE `dunning_attempts` ADD `locked_at` integer;--> statement-breakpoint
ALTER TABLE `dunning_attempts` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `dunning_attempts` ADD `last_error` text;--> statement-breakpoint
ALTER TABLE `dunning_attempts` ADD `created_at` integer;--> statement-breakpoint
ALTER TABLE `dunning_attempts` ADD `updated_at` integer;--> statement-breakpoint
CREATE INDEX `dunning_due_idx` ON `dunning_attempts` (`state`,`scheduled_for`);