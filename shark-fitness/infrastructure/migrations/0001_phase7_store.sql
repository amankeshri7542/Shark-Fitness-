CREATE TABLE `pos_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`order_id` text NOT NULL,
	`method` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`reference` text DEFAULT '' NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pos_payments_idx` ON `pos_payments` (`order_id`);--> statement-breakpoint
CREATE TABLE `retail_product_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`supplier_id` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `retail_group_idx` ON `retail_product_groups` (`tenant_id`,`name`);--> statement-breakpoint
CREATE TABLE `stock_transfer_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`transfer_id` text NOT NULL,
	`product_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`quantity_received` integer DEFAULT 0 NOT NULL,
	`unit_cost_minor` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `stock_transfer_lines_idx` ON `stock_transfer_lines` (`transfer_id`);--> statement-breakpoint
CREATE TABLE `stock_transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`reference` text NOT NULL,
	`from_branch_id` text NOT NULL,
	`to_branch_id` text NOT NULL,
	`state` text DEFAULT 'draft' NOT NULL,
	`note` text,
	`created_by` text DEFAULT '' NOT NULL,
	`dispatched_at` integer,
	`dispatched_by` text,
	`received_at` integer,
	`received_by` text,
	`cancelled_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `stock_transfer_idx` ON `stock_transfers` (`tenant_id`,`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `suppliers` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`contact_name` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`lead_time_days` integer DEFAULT 7 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `supplier_name_uq` ON `suppliers` (`tenant_id`,`name`);--> statement-breakpoint
ALTER TABLE `pos_order_lines` ADD `tax_rate_bp` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `pos_order_lines` ADD `tax_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `pos_order_lines` ADD `discount_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `pos_order_lines` ADD `unit_cost_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `pos_order_lines` ADD `quantity_returned` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `pos_orders` ADD `discount_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `pos_orders` ADD `kind` text DEFAULT 'sale' NOT NULL;--> statement-breakpoint
ALTER TABLE `pos_orders` ADD `return_of_order_id` text;--> statement-breakpoint
ALTER TABLE `pos_orders` ADD `void_reason` text;--> statement-breakpoint
ALTER TABLE `pos_orders` ADD `voided_at` integer;--> statement-breakpoint
ALTER TABLE `retail_products` ADD `group_id` text;--> statement-breakpoint
ALTER TABLE `retail_products` ADD `variant_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `retail_products` ADD `supplier_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `retail_barcode_uq` ON `retail_products` (`tenant_id`,`barcode`) WHERE barcode is not null;--> statement-breakpoint
ALTER TABLE `stock_ledger` ADD `unit_cost_minor` integer;--> statement-breakpoint
ALTER TABLE `stock_ledger` ADD `negative_override` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `stock_ledger` ADD `override_reason` text;