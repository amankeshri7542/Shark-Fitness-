CREATE TABLE `lead_consents` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`lead_id` text NOT NULL,
	`purpose` text NOT NULL,
	`granted` integer NOT NULL,
	`notice_version` text NOT NULL,
	`source` text NOT NULL,
	`request_id` text NOT NULL,
	`captured_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `lead_consents_lead_idx` ON `lead_consents` (`lead_id`,`purpose`,`captured_at`);--> statement-breakpoint
ALTER TABLE `leads` ADD `goal` text;--> statement-breakpoint
ALTER TABLE `leads` ADD `preferred_time` text;--> statement-breakpoint
ALTER TABLE `leads` ADD `interested_product_id` text;--> statement-breakpoint
ALTER TABLE `leads` ADD `utm` text;--> statement-breakpoint
ALTER TABLE `leads` ADD `referral_code` text;--> statement-breakpoint
ALTER TABLE `leads` ADD `trial_requested_at` integer;--> statement-breakpoint
ALTER TABLE `leads` ADD `trial_session_id` text;--> statement-breakpoint
ALTER TABLE `leads` ADD `trial_preferred_time` text;--> statement-breakpoint
ALTER TABLE `leads` ADD `trial_confirmed_session_id` text;--> statement-breakpoint
ALTER TABLE `leads` ADD `trial_confirmed_at` integer;--> statement-breakpoint
CREATE INDEX `leads_source_idx` ON `leads` (`tenant_id`,`source`);--> statement-breakpoint
CREATE INDEX `leads_email_idx` ON `leads` (`tenant_id`,`email_normalized`);--> statement-breakpoint
ALTER TABLE `products` ADD `is_public` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TRIGGER lead_consent_no_update BEFORE UPDATE ON lead_consents BEGIN SELECT RAISE(ABORT, 'lead consent records are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER lead_consent_no_delete BEFORE DELETE ON lead_consents BEGIN SELECT RAISE(ABORT, 'lead consent records are append-only'); END;
