ALTER TABLE `branches` ADD `email` text;--> statement-breakpoint
ALTER TABLE `branches` ADD `hours` text;--> statement-breakpoint
ALTER TABLE `branches` ADD `policy` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `branches` ADD `state_changed_at` integer;--> statement-breakpoint
ALTER TABLE `branches` ADD `state_note` text;--> statement-breakpoint
ALTER TABLE `tenants` ADD `tax_profile` text;--> statement-breakpoint
ALTER TABLE `tenants` ADD `data_processing` text;