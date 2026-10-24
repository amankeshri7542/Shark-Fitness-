CREATE TABLE `automation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`automation_id` text NOT NULL,
	`branch_id` text,
	`member_id` text,
	`user_id` text,
	`trigger` text NOT NULL,
	`event_key` text NOT NULL,
	`outcome` text NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`channel` text NOT NULL,
	`template_code` text,
	`notification_id` text,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `automation_runs_idx` ON `automation_runs` (`tenant_id`,`automation_id`,`at`);--> statement-breakpoint
CREATE INDEX `automation_runs_member_idx` ON `automation_runs` (`tenant_id`,`member_id`,`at`);