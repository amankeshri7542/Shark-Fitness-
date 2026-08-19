CREATE TABLE `feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`branch_id` text,
	`member_id` text,
	`kind` text NOT NULL,
	`score` integer,
	`comment` text DEFAULT '' NOT NULL,
	`anonymous` integer DEFAULT false NOT NULL,
	`subject_type` text,
	`subject_id` text,
	`subject_label` text,
	`ticket_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `feedback_kind_idx` ON `feedback` (`tenant_id`,`kind`,`created_at`);--> statement-breakpoint
CREATE INDEX `feedback_branch_idx` ON `feedback` (`tenant_id`,`branch_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `interventions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`member_id` text NOT NULL,
	`ticket_id` text,
	`risk_score_at_creation` integer NOT NULL,
	`risk_band_at_creation` text NOT NULL,
	`risk_reasons_at_creation` text NOT NULL,
	`recommended_action` text NOT NULL,
	`action` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`assignee_id` text,
	`assignee_name` text,
	`due_at` integer NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`outcome` text,
	`outcome_note` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `interventions_member_idx` ON `interventions` (`tenant_id`,`member_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `interventions_state_idx` ON `interventions` (`tenant_id`,`state`,`due_at`);--> statement-breakpoint
CREATE TABLE `ticket_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`ticket_id` text NOT NULL,
	`kind` text NOT NULL,
	`actor_id` text,
	`actor_name` text NOT NULL,
	`actor_role` text NOT NULL,
	`summary` text NOT NULL,
	`detail` text,
	`message_id` text,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ticket_events_ticket_idx` ON `ticket_events` (`ticket_id`,`at`);--> statement-breakpoint
ALTER TABLE `tickets` ADD `first_response_at` integer;--> statement-breakpoint
ALTER TABLE `tickets` ADD `sla_response_minutes` integer;--> statement-breakpoint
ALTER TABLE `tickets` ADD `resolved_at` integer;--> statement-breakpoint
ALTER TABLE `tickets` ADD `resolved_by` text;--> statement-breakpoint
ALTER TABLE `tickets` ADD `escalated_at` integer;--> statement-breakpoint
ALTER TABLE `tickets` ADD `escalated_by` text;--> statement-breakpoint
ALTER TABLE `tickets` ADD `escalation_reason` text;--> statement-breakpoint
ALTER TABLE `tickets` ADD `reopen_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tickets` ADD `vulnerability_flag` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `tickets` ADD `safety_categories` text;--> statement-breakpoint
CREATE INDEX `tickets_assignee_idx` ON `tickets` (`tenant_id`,`assignee_id`,`state`);--> statement-breakpoint
CREATE INDEX `tickets_member_idx` ON `tickets` (`tenant_id`,`member_id`);