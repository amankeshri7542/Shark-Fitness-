CREATE TABLE `broadcasts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`channel` text NOT NULL,
	`purpose` text NOT NULL,
	`segment` text NOT NULL,
	`branch_ids` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`state` text DEFAULT 'draft' NOT NULL,
	`recipient_count` integer DEFAULT 0 NOT NULL,
	`estimated_cost_minor` integer DEFAULT 0 NOT NULL,
	`approval_required` integer DEFAULT false NOT NULL,
	`approved_by_user_id` text,
	`approved_at` integer,
	`last_dry_run_at` integer,
	`created_by_user_id` text NOT NULL,
	`sent_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `broadcasts_tenant_idx` ON `broadcasts` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `community_bans` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`member_id` text NOT NULL,
	`reason` text NOT NULL,
	`banned_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`lifted_at` integer,
	`lifted_by_user_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `community_bans_live_uq` ON `community_bans` (`tenant_id`,`member_id`) WHERE lifted_at is null;--> statement-breakpoint
CREATE TABLE `community_mutes` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`member_id` text NOT NULL,
	`muted_member_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `community_mutes_uq` ON `community_mutes` (`member_id`,`muted_member_id`);--> statement-breakpoint
CREATE TABLE `conversation_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`author_user_id` text NOT NULL,
	`author_name` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `conversation_notes_idx` ON `conversation_notes` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `message_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`message_id` text,
	`uploader_user_id` text NOT NULL,
	`storage_key` text NOT NULL,
	`file_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `message_attachments_conversation_idx` ON `message_attachments` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `message_attachments_message_idx` ON `message_attachments` (`message_id`);--> statement-breakpoint
CREATE TABLE `notification_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`branch_id` text,
	`user_id` text NOT NULL,
	`member_id` text,
	`channel` text NOT NULL,
	`purpose` text NOT NULL,
	`source` text NOT NULL,
	`source_id` text,
	`dedupe_key` text,
	`kind` text DEFAULT 'system' NOT NULL,
	`title` text NOT NULL,
	`body_template` text NOT NULL,
	`variables` text NOT NULL,
	`provider_template` text,
	`link` text,
	`state` text DEFAULT 'queued' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`provider` text,
	`provider_message_id` text,
	`destination_hint` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`due_at` integer NOT NULL,
	`locked_at` integer,
	`last_attempt_at` integer,
	`delivered_at` integer,
	`notification_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notification_deliveries_due_idx` ON `notification_deliveries` (`state`,`due_at`);--> statement-breakpoint
CREATE INDEX `notification_deliveries_source_idx` ON `notification_deliveries` (`tenant_id`,`source`,`source_id`);--> statement-breakpoint
CREATE INDEX `notification_deliveries_user_idx` ON `notification_deliveries` (`user_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `notification_deliveries_dedupe_uq` ON `notification_deliveries` (`tenant_id`,`channel`,`dedupe_key`) WHERE dedupe_key is not null;--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`title` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`source` text NOT NULL,
	`source_type` text,
	`source_id` text,
	`generation_key` text,
	`member_id` text,
	`lead_id` text,
	`link` text,
	`assignee_staff_id` text,
	`created_by_user_id` text,
	`priority` text DEFAULT 'normal' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`due_at` integer,
	`outcome` text,
	`completed_at` integer,
	`completed_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tasks_status_idx` ON `tasks` (`tenant_id`,`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `tasks_assignee_idx` ON `tasks` (`assignee_staff_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_generation_uq` ON `tasks` (`tenant_id`,`generation_key`) WHERE generation_key is not null;--> statement-breakpoint
ALTER TABLE `habits` ADD `template_key` text;--> statement-breakpoint
ALTER TABLE `habits` ADD `assigned_by_staff_id` text;--> statement-breakpoint
ALTER TABLE `weekly_check_ins` ADD `coach_reply_by_name` text;--> statement-breakpoint
ALTER TABLE `comments` ADD `moderation_reason` text;--> statement-breakpoint
ALTER TABLE `comments` ADD `moderated_at` integer;--> statement-breakpoint
ALTER TABLE `comments` ADD `moderated_by_user_id` text;--> statement-breakpoint
ALTER TABLE `content_reports` ADD `resolved_at` integer;--> statement-breakpoint
ALTER TABLE `conversations` ADD `branch_id` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `topic` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `assigned_staff_id` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `staff_read_at` integer;--> statement-breakpoint
ALTER TABLE `conversations` ADD `started_by` text;--> statement-breakpoint
ALTER TABLE `posts` ADD `moderation_reason` text;--> statement-breakpoint
ALTER TABLE `posts` ADD `moderated_at` integer;--> statement-breakpoint
ALTER TABLE `posts` ADD `moderated_by_user_id` text;--> statement-breakpoint
UPDATE `conversations` SET `branch_id` = (SELECT `home_branch_id` FROM `members` WHERE `members`.`id` = `conversations`.`member_id`) WHERE `branch_id` IS NULL;
