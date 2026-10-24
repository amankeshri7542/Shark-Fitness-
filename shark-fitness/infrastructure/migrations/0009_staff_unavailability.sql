CREATE TABLE `staff_unavailability` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`staff_id` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`reason` text NOT NULL,
	`note` text,
	`state` text DEFAULT 'active' NOT NULL,
	`created_by_user_id` text NOT NULL,
	`withdrawn_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `staff_unavailability_staff_idx` ON `staff_unavailability` (`staff_id`,`starts_at`);