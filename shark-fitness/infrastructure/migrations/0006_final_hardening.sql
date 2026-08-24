CREATE TABLE `automation_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`automation_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`member_id` text NOT NULL,
	`user_id` text NOT NULL,
	`event_key` text NOT NULL,
	`channel` text NOT NULL,
	`template_code` text,
	`template_version` integer,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`due_at` integer NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_attempt_at` integer,
	`locked_at` integer,
	`last_error` text,
	`notification_id` text,
	`source` text NOT NULL,
	`actor_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_deliveries_event_uq` ON `automation_deliveries` (`automation_id`,`event_key`);--> statement-breakpoint
CREATE INDEX `automation_deliveries_due_idx` ON `automation_deliveries` (`state`,`due_at`);--> statement-breakpoint
CREATE INDEX `automation_deliveries_tenant_idx` ON `automation_deliveries` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `automation_deliveries_retention_idx` ON `automation_deliveries` (`updated_at`,`state`);--> statement-breakpoint
CREATE TABLE `job_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`job` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text DEFAULT 'running' NOT NULL,
	`duration_ms` integer,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `job_runs_job_idx` ON `job_runs` (`job`,`started_at`);--> statement-breakpoint
CREATE INDEX `job_runs_retention_idx` ON `job_runs` (`finished_at`,`status`);--> statement-breakpoint
ALTER TABLE `automation_runs` ADD `delivery_id` text;--> statement-breakpoint
CREATE INDEX `automation_runs_retention_idx` ON `automation_runs` (`at`,`outcome`);--> statement-breakpoint
CREATE UNIQUE INDEX `automation_runs_delivery_uq` ON `automation_runs` (`delivery_id`) WHERE delivery_id is not null;--> statement-breakpoint
ALTER TABLE `automations` ADD `branch_ids` text;--> statement-breakpoint
UPDATE `automations`
SET `actions` = json_set(
	`actions`,
	'$[0].templateId', (
		SELECT `message_templates`.`id`
		FROM `message_templates`
		WHERE `message_templates`.`tenant_id` = `automations`.`tenant_id`
			AND `message_templates`.`code` = json_extract(`automations`.`actions`, '$[0].templateCode')
		ORDER BY `message_templates`.`version` DESC
		LIMIT 1
	),
	'$[0].templateVersion', (
		SELECT `message_templates`.`version`
		FROM `message_templates`
		WHERE `message_templates`.`tenant_id` = `automations`.`tenant_id`
			AND `message_templates`.`code` = json_extract(`automations`.`actions`, '$[0].templateCode')
		ORDER BY `message_templates`.`version` DESC
		LIMIT 1
	)
)
WHERE json_extract(`actions`, '$[0].templateCode') is not null
	AND (
		json_extract(`actions`, '$[0].templateId') is null
		OR json_extract(`actions`, '$[0].templateVersion') is null
	)
	AND EXISTS (
		SELECT 1
		FROM `message_templates`
		WHERE `message_templates`.`tenant_id` = `automations`.`tenant_id`
			AND `message_templates`.`code` = json_extract(`automations`.`actions`, '$[0].templateCode')
	);--> statement-breakpoint
CREATE UNIQUE INDEX `message_templates_version_uq` ON `message_templates` (`tenant_id`,`code`,`version`);--> statement-breakpoint
CREATE INDEX `used_windows_used_at_idx` ON `used_access_windows` (`used_at`);--> statement-breakpoint
CREATE INDEX `idempotency_created_idx` ON `idempotency_keys` (`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_seq_uq` ON `outbox_events` (`seq`);--> statement-breakpoint
CREATE INDEX `outbox_retention_idx` ON `outbox_events` (`at`,`delivered_at`,`seq`) WHERE delivered_at is not null;--> statement-breakpoint
CREATE INDEX `sessions_expiry_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `sessions_revoked_idx` ON `sessions` (`revoked_at`) WHERE revoked_at is not null;--> statement-breakpoint
CREATE INDEX `otp_expiry_idx` ON `otp_challenges` (`expires_at`);--> statement-breakpoint
CREATE INDEX `otp_consumed_idx` ON `otp_challenges` (`consumed_at`) WHERE consumed_at is not null;
