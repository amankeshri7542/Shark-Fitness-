CREATE TABLE `legal_holds` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`subject_user_id` text NOT NULL,
	`subject_member_id` text,
	`reason` text NOT NULL,
	`reference` text,
	`placed_by_user_id` text NOT NULL,
	`placed_at` integer NOT NULL,
	`released_at` integer,
	`released_by_user_id` text,
	`release_reason` text
);
--> statement-breakpoint
CREATE INDEX `legal_holds_subject_idx` ON `legal_holds` (`subject_user_id`,`released_at`);--> statement-breakpoint
CREATE TABLE `privacy_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`request_id` text NOT NULL,
	`format` text DEFAULT 'json' NOT NULL,
	`payload` text NOT NULL,
	`byte_size` integer NOT NULL,
	`checksum` text NOT NULL,
	`generated_by_user_id` text NOT NULL,
	`generated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `privacy_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`subject_user_id` text NOT NULL,
	`subject_member_id` text,
	`kind` text NOT NULL,
	`state` text DEFAULT 'submitted' NOT NULL,
	`requested_by_user_id` text NOT NULL,
	`reason` text,
	`submitted_at` integer NOT NULL,
	`reviewed_at` integer,
	`reviewed_by_user_id` text,
	`completed_at` integer,
	`completed_by_user_id` text,
	`outcome_note` text,
	`artifact_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `privacy_requests_subject_idx` ON `privacy_requests` (`subject_user_id`,`submitted_at`);--> statement-breakpoint
CREATE INDEX `privacy_requests_state_idx` ON `privacy_requests` (`tenant_id`,`state`);