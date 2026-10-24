CREATE TABLE `class_series` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`class_type_id` text NOT NULL,
	`room_id` text,
	`trainer_id` text,
	`frequency` text DEFAULT 'weekly' NOT NULL,
	`interval` integer DEFAULT 1 NOT NULL,
	`weekdays` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`occurrence_count` integer,
	`start_time` text NOT NULL,
	`duration_min` integer NOT NULL,
	`capacity` integer NOT NULL,
	`credits_required` integer DEFAULT 0 NOT NULL,
	`drop_in_price_minor` integer,
	`late_cancel_fee_minor` integer DEFAULT 0 NOT NULL,
	`waitlist_enabled` integer DEFAULT true NOT NULL,
	`booking_opens_min_before` integer,
	`cancel_deadline_min_before` integer,
	`notes` text,
	`state` text DEFAULT 'active' NOT NULL,
	`generated_through` text,
	`supersedes_series_id` text,
	`superseded_by_series_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `class_series_branch_idx` ON `class_series` (`branch_id`,`state`);--> statement-breakpoint
ALTER TABLE `class_sessions` ADD `occurrence_date` text;