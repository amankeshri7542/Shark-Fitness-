ALTER TABLE `commission_lines` ADD `branch_id` text;--> statement-breakpoint
ALTER TABLE `commission_lines` ADD `correction_of_line_id` text;--> statement-breakpoint
ALTER TABLE `commission_lines` ADD `correction_reason` text;--> statement-breakpoint
ALTER TABLE `commission_lines` ADD `approved_by_user_id` text;--> statement-breakpoint
ALTER TABLE `commission_lines` ADD `approved_at` integer;--> statement-breakpoint
ALTER TABLE `commission_lines` ADD `paid_by_user_id` text;--> statement-breakpoint
ALTER TABLE `commission_lines` ADD `paid_at` integer;--> statement-breakpoint
ALTER TABLE `commission_lines` ADD `paid_reference` text;--> statement-breakpoint
CREATE INDEX `commission_state_idx` ON `commission_lines` (`tenant_id`,`state`);