CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`branch_id` text,
	`actor_id` text,
	`actor_name` text NOT NULL,
	`actor_role` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`entity_label` text DEFAULT '' NOT NULL,
	`reason` text,
	`changes` text NOT NULL,
	`ip` text,
	`request_id` text,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_tenant_at_idx` ON `audit_log` (`tenant_id`,`at`);--> statement-breakpoint
CREATE INDEX `audit_entity_idx` ON `audit_log` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `automations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`trigger` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`conditions` text NOT NULL,
	`actions` text NOT NULL,
	`quiet_hours` text,
	`state` text DEFAULT 'draft' NOT NULL,
	`dry_run` integer DEFAULT true NOT NULL,
	`runs_last_30` integer DEFAULT 0 NOT NULL,
	`last_run_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `branches` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`address_line` text NOT NULL,
	`city` text NOT NULL,
	`timezone` text NOT NULL,
	`capacity` integer NOT NULL,
	`opens_minutes` integer NOT NULL,
	`closes_minutes` integer NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`amenities` text NOT NULL,
	`holidays` text NOT NULL,
	`phone` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `branches_tenant_idx` ON `branches` (`tenant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `branches_tenant_slug_uq` ON `branches` (`tenant_id`,`slug`);--> statement-breakpoint
CREATE TABLE `consents` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`purpose` text NOT NULL,
	`granted` integer NOT NULL,
	`version` text NOT NULL,
	`updated_at` integer NOT NULL,
	`ip` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `consents_user_purpose_uq` ON `consents` (`user_id`,`purpose`);--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`key` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`route` text NOT NULL,
	`request_hash` text NOT NULL,
	`response_body` text,
	`status_code` integer DEFAULT 200 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `message_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`code` text NOT NULL,
	`channel` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`subject` text,
	`body` text NOT NULL,
	`variables` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `metric_rollups` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`branch_id` text,
	`metric` text NOT NULL,
	`period` text NOT NULL,
	`on_date` text NOT NULL,
	`value` integer NOT NULL,
	`computed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rollup_uq` ON `metric_rollups` (`tenant_id`,`branch_id`,`metric`,`period`,`on_date`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`channel` text DEFAULT 'in_app' NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`link` text,
	`template_code` text,
	`state` text DEFAULT 'sent' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`read_at` integer
);
--> statement-breakpoint
CREATE INDEX `notifications_user_idx` ON `notifications` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `otp_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`identifier` text NOT NULL,
	`code_hash` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer
);
--> statement-breakpoint
CREATE INDEX `otp_identifier_idx` ON `otp_challenges` (`identifier`);--> statement-breakpoint
CREATE TABLE `outbox_events` (
	`id` text PRIMARY KEY NOT NULL,
	`seq` integer NOT NULL,
	`tenant_id` text NOT NULL,
	`branch_id` text,
	`channel` text NOT NULL,
	`topic` text NOT NULL,
	`payload` text NOT NULL,
	`at` integer NOT NULL,
	`delivered_at` integer
);
--> statement-breakpoint
CREATE INDEX `outbox_channel_seq_idx` ON `outbox_events` (`channel`,`seq`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`user_agent` text DEFAULT '' NOT NULL,
	`ip` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`impersonator_id` text,
	`impersonation_expires_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`legal_name` text NOT NULL,
	`display_name` text NOT NULL,
	`plan` text DEFAULT 'growth' NOT NULL,
	`locale` text DEFAULT 'en-IN' NOT NULL,
	`currency` text DEFAULT 'INR' NOT NULL,
	`timezone` text DEFAULT 'Asia/Kolkata' NOT NULL,
	`unit_system` text DEFAULT 'metric' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`feature_flags` text NOT NULL,
	`quotas` text NOT NULL,
	`branding` text NOT NULL,
	`policy` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenants_slug_unique` ON `tenants` (`slug`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`email` text,
	`phone` text,
	`name` text NOT NULL,
	`initials` text NOT NULL,
	`role` text NOT NULL,
	`account_state` text DEFAULT 'active' NOT NULL,
	`password_hash` text,
	`preferences` text NOT NULL,
	`last_seen_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `users_tenant_idx` ON `users` (`tenant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_tenant_email_uq` ON `users` (`tenant_id`,`email`);--> statement-breakpoint
CREATE TABLE `commission_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`staff_id` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`kind` text NOT NULL,
	`basis_minor` integer NOT NULL,
	`rate_pct` real NOT NULL,
	`amount_minor` integer NOT NULL,
	`rule_version` text NOT NULL,
	`evidence` text NOT NULL,
	`state` text DEFAULT 'accrued' NOT NULL,
	`ref_type` text,
	`ref_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `commission_staff_idx` ON `commission_lines` (`staff_id`,`period_start`);--> statement-breakpoint
CREATE TABLE `credits` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`member_id` text NOT NULL,
	`kind` text NOT NULL,
	`delta` integer NOT NULL,
	`reason` text NOT NULL,
	`ref_type` text,
	`ref_id` text,
	`expires_on` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `credits_member_idx` ON `credits` (`member_id`,`kind`);--> statement-breakpoint
CREATE TABLE `lead_activities` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`lead_id` text NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`actor_id` text,
	`actor_name` text NOT NULL,
	`from_stage` text,
	`to_stage` text,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `lead_activities_idx` ON `lead_activities` (`lead_id`,`at`);--> statement-breakpoint
CREATE TABLE `leads` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`name` text NOT NULL,
	`phone` text,
	`email` text,
	`phone_normalized` text,
	`email_normalized` text,
	`source` text NOT NULL,
	`campaign` text,
	`stage` text DEFAULT 'new' NOT NULL,
	`owner_id` text,
	`expected_value_minor` integer DEFAULT 0 NOT NULL,
	`next_action_at` integer,
	`next_action_label` text,
	`last_touched_at` integer,
	`loss_reason` text,
	`converted_member_id` text,
	`duplicate_of_id` text,
	`tags` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `leads_stage_idx` ON `leads` (`tenant_id`,`stage`);--> statement-breakpoint
CREATE INDEX `leads_phone_idx` ON `leads` (`tenant_id`,`phone_normalized`);--> statement-breakpoint
CREATE INDEX `leads_owner_idx` ON `leads` (`owner_id`);--> statement-breakpoint
CREATE TABLE `member_branches` (
	`member_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`tenant_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_branches_uq` ON `member_branches` (`member_id`,`branch_id`);--> statement-breakpoint
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text,
	`home_branch_id` text NOT NULL,
	`member_no` text NOT NULL,
	`first_name` text NOT NULL,
	`last_name` text NOT NULL,
	`initials` text NOT NULL,
	`email` text,
	`phone` text,
	`phone_normalized` text,
	`email_normalized` text,
	`dob` text,
	`gender` text,
	`address_line` text,
	`emergency_contact` text,
	`lifecycle` text DEFAULT 'active' NOT NULL,
	`tags` text NOT NULL,
	`trainer_id` text,
	`guardian_id` text,
	`corporate_sponsor_id` text,
	`member_notes` text,
	`staff_notes` text,
	`risk_score` integer,
	`risk_reasons` text,
	`joined_on` text NOT NULL,
	`last_visit_at` integer,
	`merged_into_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `members_tenant_idx` ON `members` (`tenant_id`,`lifecycle`);--> statement-breakpoint
CREATE INDEX `members_branch_idx` ON `members` (`tenant_id`,`home_branch_id`);--> statement-breakpoint
CREATE INDEX `members_phone_idx` ON `members` (`tenant_id`,`phone_normalized`);--> statement-breakpoint
CREATE INDEX `members_email_idx` ON `members` (`tenant_id`,`email_normalized`);--> statement-breakpoint
CREATE UNIQUE INDEX `members_no_uq` ON `members` (`tenant_id`,`member_no`);--> statement-breakpoint
CREATE INDEX `members_trainer_idx` ON `members` (`trainer_id`);--> statement-breakpoint
CREATE TABLE `membership_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`membership_id` text NOT NULL,
	`from_state` text NOT NULL,
	`to_state` text NOT NULL,
	`reason` text NOT NULL,
	`actor_id` text,
	`actor_name` text NOT NULL,
	`source` text NOT NULL,
	`effective_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `membership_events_idx` ON `membership_events` (`membership_id`,`effective_at`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`member_id` text NOT NULL,
	`product_id` text NOT NULL,
	`product_name` text NOT NULL,
	`product_snapshot` text NOT NULL,
	`state` text DEFAULT 'draft' NOT NULL,
	`started_on` text NOT NULL,
	`ends_on` text,
	`auto_renew` integer DEFAULT true NOT NULL,
	`price_minor` integer NOT NULL,
	`currency` text DEFAULT 'INR' NOT NULL,
	`freeze_days_used` integer DEFAULT 0 NOT NULL,
	`freeze_started_on` text,
	`grace_ends_on` text,
	`cancel_effective_on` text,
	`previous_membership_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `memberships_member_idx` ON `memberships` (`member_id`,`state`);--> statement-breakpoint
CREATE INDEX `memberships_tenant_state_idx` ON `memberships` (`tenant_id`,`state`,`ends_on`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`price_minor` integer NOT NULL,
	`currency` text DEFAULT 'INR' NOT NULL,
	`tax_rate_bp` integer DEFAULT 1800 NOT NULL,
	`cadence` text NOT NULL,
	`duration_days` integer,
	`credits` integer,
	`credits_expire_days` integer,
	`access` text NOT NULL,
	`freeze` text NOT NULL,
	`cancellation` text NOT NULL,
	`eligibility` text NOT NULL,
	`branch_ids` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `products_tenant_idx` ON `products` (`tenant_id`,`status`);--> statement-breakpoint
CREATE TABLE `shifts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`staff_id` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`role` text NOT NULL,
	`state` text DEFAULT 'planned' NOT NULL,
	`covered_by_staff_id` text,
	`note` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `shifts_branch_time_idx` ON `shifts` (`branch_id`,`starts_at`);--> statement-breakpoint
CREATE TABLE `staff` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`employment_status` text DEFAULT 'active' NOT NULL,
	`branch_ids` text NOT NULL,
	`specialties` text NOT NULL,
	`certifications` text NOT NULL,
	`commission_rules` text NOT NULL,
	`hourly_rate_minor` integer,
	`joined_on` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `staff_tenant_idx` ON `staff` (`tenant_id`,`employment_status`);--> statement-breakpoint
CREATE TABLE `access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`member_id` text NOT NULL,
	`seed` text NOT NULL,
	`issued_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE INDEX `access_tokens_member_idx` ON `access_tokens` (`member_id`);--> statement-breakpoint
CREATE TABLE `appointments` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`member_id` text NOT NULL,
	`trainer_id` text NOT NULL,
	`kind` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`state` text DEFAULT 'confirmed' NOT NULL,
	`credits_used` integer DEFAULT 0 NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `appointments_trainer_idx` ON `appointments` (`trainer_id`,`starts_at`);--> statement-breakpoint
CREATE TABLE `bookings` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`session_id` text NOT NULL,
	`member_id` text NOT NULL,
	`state` text DEFAULT 'confirmed' NOT NULL,
	`seat_no` integer,
	`booked_at` integer NOT NULL,
	`cancelled_at` integer,
	`held_until` integer,
	`credits_used` integer DEFAULT 0 NOT NULL,
	`charge_minor` integer DEFAULT 0 NOT NULL,
	`came_from_waitlist` integer DEFAULT false NOT NULL,
	`idempotency_key` text NOT NULL,
	`attended_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bookings_idem_uq` ON `bookings` (`tenant_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `bookings_session_idx` ON `bookings` (`session_id`,`state`);--> statement-breakpoint
CREATE INDEX `bookings_member_idx` ON `bookings` (`member_id`,`booked_at`);--> statement-breakpoint
CREATE TABLE `check_ins` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`member_id` text,
	`method` text NOT NULL,
	`decision` text NOT NULL,
	`entered_at` integer NOT NULL,
	`exited_at` integer,
	`auto_closed` integer DEFAULT false NOT NULL,
	`override_by_id` text,
	`override_by_name` text,
	`override_reason` text,
	`visit_number` integer
);
--> statement-breakpoint
CREATE INDEX `checkins_branch_time_idx` ON `check_ins` (`branch_id`,`entered_at`);--> statement-breakpoint
CREATE INDEX `checkins_member_idx` ON `check_ins` (`member_id`,`entered_at`);--> statement-breakpoint
CREATE INDEX `checkins_open_idx` ON `check_ins` (`branch_id`,`exited_at`);--> statement-breakpoint
CREATE TABLE `class_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`class_type_id` text NOT NULL,
	`room_id` text,
	`trainer_id` text,
	`series_id` text,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`capacity` integer NOT NULL,
	`booked` integer DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'scheduled' NOT NULL,
	`booking_opens_at` integer,
	`cancel_deadline_at` integer,
	`credits_required` integer DEFAULT 0 NOT NULL,
	`drop_in_price_minor` integer,
	`late_cancel_fee_minor` integer DEFAULT 0 NOT NULL,
	`waitlist_enabled` integer DEFAULT true NOT NULL,
	`cancelled_reason` text,
	`substitute_for` text,
	`notes` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_branch_time_idx` ON `class_sessions` (`branch_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `sessions_trainer_idx` ON `class_sessions` (`trainer_id`,`starts_at`);--> statement-breakpoint
CREATE TABLE `class_types` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`duration_min` integer NOT NULL,
	`intensity` text DEFAULT 'moderate' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `commission_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`kind` text NOT NULL,
	`rate_pct` real NOT NULL,
	`version` text NOT NULL,
	`effective_from` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `dunning_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`channel` text NOT NULL,
	`scheduled_for` integer NOT NULL,
	`state` text DEFAULT 'scheduled' NOT NULL,
	`sent_at` integer,
	`stop_reason` text
);
--> statement-breakpoint
CREATE INDEX `dunning_invoice_idx` ON `dunning_attempts` (`invoice_id`,`attempt`);--> statement-breakpoint
CREATE TABLE `equipment` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`name` text NOT NULL,
	`asset_tag` text NOT NULL,
	`area` text NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`serial` text DEFAULT '' NOT NULL,
	`vendor` text DEFAULT '' NOT NULL,
	`warranty_until` text,
	`status` text DEFAULT 'available' NOT NULL,
	`last_serviced_on` text,
	`service_interval_days` integer DEFAULT 90 NOT NULL,
	`linked_exercise_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `equipment_tag_uq` ON `equipment` (`tenant_id`,`asset_tag`);--> statement-breakpoint
CREATE TABLE `facility_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`title` text NOT NULL,
	`cadence` text NOT NULL,
	`next_due_at` integer NOT NULL,
	`assignee_id` text,
	`state` text DEFAULT 'open' NOT NULL,
	`checklist` text NOT NULL,
	`last_completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `facility_tasks_due_idx` ON `facility_tasks` (`branch_id`,`next_due_at`);--> statement-breakpoint
CREATE TABLE `invoice_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`description` text NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`unit_minor` integer NOT NULL,
	`discount_minor` integer DEFAULT 0 NOT NULL,
	`tax_rate_bp` integer NOT NULL,
	`tax_minor` integer NOT NULL,
	`total_minor` integer NOT NULL,
	`product_id` text
);
--> statement-breakpoint
CREATE INDEX `invoice_lines_idx` ON `invoice_lines` (`invoice_id`);--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`member_id` text NOT NULL,
	`number` text NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`issued_on` text NOT NULL,
	`due_on` text NOT NULL,
	`currency` text DEFAULT 'INR' NOT NULL,
	`subtotal_minor` integer NOT NULL,
	`discount_minor` integer DEFAULT 0 NOT NULL,
	`tax_minor` integer NOT NULL,
	`total_minor` integer NOT NULL,
	`paid_minor` integer DEFAULT 0 NOT NULL,
	`refunded_minor` integer DEFAULT 0 NOT NULL,
	`voided` integer DEFAULT false NOT NULL,
	`void_reason` text,
	`ref_type` text,
	`ref_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_number_uq` ON `invoices` (`tenant_id`,`number`);--> statement-breakpoint
CREATE INDEX `invoices_member_idx` ON `invoices` (`member_id`,`state`);--> statement-breakpoint
CREATE INDEX `invoices_tenant_state_idx` ON `invoices` (`tenant_id`,`state`,`due_on`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`branch_id` text,
	`invoice_id` text,
	`member_id` text NOT NULL,
	`method` text NOT NULL,
	`state` text DEFAULT 'created' NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text DEFAULT 'INR' NOT NULL,
	`provider` text,
	`provider_ref` text,
	`idempotency_key` text NOT NULL,
	`recorded_by_id` text,
	`recorded_by_name` text,
	`failure_reason` text,
	`note` text,
	`created_at` integer NOT NULL,
	`settled_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_idem_uq` ON `payments` (`tenant_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `payments_invoice_idx` ON `payments` (`invoice_id`);--> statement-breakpoint
CREATE INDEX `payments_member_idx` ON `payments` (`member_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `pos_order_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`order_id` text NOT NULL,
	`product_id` text NOT NULL,
	`name` text NOT NULL,
	`quantity` integer NOT NULL,
	`unit_minor` integer NOT NULL,
	`total_minor` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pos_lines_idx` ON `pos_order_lines` (`order_id`);--> statement-breakpoint
CREATE TABLE `pos_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`reference` text NOT NULL,
	`member_id` text,
	`subtotal_minor` integer NOT NULL,
	`tax_minor` integer NOT NULL,
	`total_minor` integer NOT NULL,
	`state` text DEFAULT 'paid' NOT NULL,
	`staff_id` text,
	`staff_name` text NOT NULL,
	`invoice_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pos_branch_idx` ON `pos_orders` (`branch_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `provider_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_event_id` text NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`signature_ok` integer NOT NULL,
	`received_at` integer NOT NULL,
	`processed_at` integer,
	`processing_error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_events_uq` ON `provider_events` (`provider`,`provider_event_id`);--> statement-breakpoint
CREATE TABLE `refunds` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`payment_id` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`reason` text NOT NULL,
	`state` text DEFAULT 'succeeded' NOT NULL,
	`entitlement_reversed` integer DEFAULT false NOT NULL,
	`actor_name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `refunds_payment_idx` ON `refunds` (`payment_id`);--> statement-breakpoint
CREATE TABLE `retail_products` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`sku` text NOT NULL,
	`barcode` text,
	`category` text NOT NULL,
	`price_minor` integer NOT NULL,
	`cost_minor` integer NOT NULL,
	`tax_rate_bp` integer DEFAULT 1800 NOT NULL,
	`reorder_at` integer DEFAULT 5 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `retail_sku_uq` ON `retail_products` (`tenant_id`,`sku`);--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`name` text NOT NULL,
	`capacity` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stock_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`product_id` text NOT NULL,
	`delta` integer NOT NULL,
	`reason` text NOT NULL,
	`ref_type` text,
	`ref_id` text,
	`actor_name` text NOT NULL,
	`note` text,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `stock_product_idx` ON `stock_ledger` (`product_id`,`branch_id`,`at`);--> statement-breakpoint
CREATE TABLE `tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`branch_id` text,
	`member_id` text,
	`reference` text NOT NULL,
	`category` text NOT NULL,
	`subject` text NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`assignee_id` text,
	`sla_due_at` integer,
	`resolution` text,
	`anonymous` integer DEFAULT false NOT NULL,
	`escalated` integer DEFAULT false NOT NULL,
	`opened_at` integer NOT NULL,
	`last_update_at` integer NOT NULL,
	`closed_at` integer
);
--> statement-breakpoint
CREATE INDEX `tickets_state_idx` ON `tickets` (`tenant_id`,`state`,`sla_due_at`);--> statement-breakpoint
CREATE TABLE `used_access_windows` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`member_id` text NOT NULL,
	`window` integer NOT NULL,
	`used_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `used_windows_uq` ON `used_access_windows` (`member_id`,`window`);--> statement-breakpoint
CREATE TABLE `waitlist_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`session_id` text NOT NULL,
	`member_id` text NOT NULL,
	`position` integer NOT NULL,
	`state` text DEFAULT 'waiting' NOT NULL,
	`joined_at` integer NOT NULL,
	`offered_at` integer,
	`offer_expires_at` integer,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `waitlist_uq` ON `waitlist_entries` (`session_id`,`member_id`);--> statement-breakpoint
CREATE INDEX `waitlist_session_idx` ON `waitlist_entries` (`session_id`,`position`);--> statement-breakpoint
CREATE TABLE `work_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`reference` text NOT NULL,
	`equipment_id` text,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`severity` text DEFAULT 'medium' NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`reported_by_id` text,
	`reported_by_name` text NOT NULL,
	`reported_by_kind` text DEFAULT 'staff' NOT NULL,
	`assignee_id` text,
	`cost_minor` integer DEFAULT 0 NOT NULL,
	`duplicate_of_id` text,
	`opened_at` integer NOT NULL,
	`closed_at` integer
);
--> statement-breakpoint
CREATE INDEX `work_orders_branch_idx` ON `work_orders` (`branch_id`,`state`);--> statement-breakpoint
CREATE TABLE `adaptive_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`member_id` text NOT NULL,
	`assignment_id` text NOT NULL,
	`program_item_id` text,
	`rules_version` text NOT NULL,
	`headline` text NOT NULL,
	`explanation` text NOT NULL,
	`inputs` text NOT NULL,
	`changes` text NOT NULL,
	`confidence` text NOT NULL,
	`limitations` text NOT NULL,
	`reviewed_by_id` text,
	`reviewed_by_name` text,
	`reviewed_at` integer,
	`member_decision` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `adaptive_member_idx` ON `adaptive_decisions` (`member_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `assessments` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`member_id` text NOT NULL,
	`template` text NOT NULL,
	`trainer_id` text,
	`values` text NOT NULL,
	`trainer_only` text NOT NULL,
	`member_note` text,
	`taken_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `assessments_member_idx` ON `assessments` (`member_id`,`taken_at`);--> statement-breakpoint
CREATE TABLE `assignment_overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`assignment_id` text NOT NULL,
	`program_item_id` text NOT NULL,
	`week` integer NOT NULL,
	`load_kg` real,
	`substitute_exercise_id` text,
	`reason` text NOT NULL,
	`source` text DEFAULT 'adaptive' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assignment_override_uq` ON `assignment_overrides` (`assignment_id`,`program_item_id`,`week`);--> statement-breakpoint
CREATE TABLE `assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`member_id` text NOT NULL,
	`program_id` text NOT NULL,
	`program_version` integer NOT NULL,
	`trainer_id` text,
	`starts_on` text NOT NULL,
	`current_week` integer DEFAULT 1 NOT NULL,
	`current_block` text DEFAULT 'A' NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `assignments_member_idx` ON `assignments` (`member_id`,`state`);--> statement-breakpoint
CREATE TABLE `daily_metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`member_id` text NOT NULL,
	`on_date` text NOT NULL,
	`water_ml` integer DEFAULT 0 NOT NULL,
	`sleep_min` integer,
	`steps` integer,
	`kcal` integer,
	`protein_g` integer,
	`carbs_g` integer,
	`fat_g` integer,
	`mood` integer,
	`energy` integer,
	`soreness` integer,
	`last_source` text,
	`duplicate_source` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `daily_metrics_uq` ON `daily_metrics` (`member_id`,`on_date`);--> statement-breakpoint
CREATE TABLE `exercises` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`aliases` text NOT NULL,
	`equipment` text NOT NULL,
	`primary_muscles` text NOT NULL,
	`secondary_muscles` text NOT NULL,
	`difficulty` text DEFAULT 'intermediate' NOT NULL,
	`instructions` text NOT NULL,
	`cues` text NOT NULL,
	`contraindications` text NOT NULL,
	`substitution_ids` text NOT NULL,
	`is_unilateral` integer DEFAULT false NOT NULL,
	`uses_barbell` integer DEFAULT false NOT NULL,
	`default_rest_sec` integer DEFAULT 90 NOT NULL,
	`load_step_kg` real DEFAULT 2.5 NOT NULL,
	`media_url` text,
	`archived` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exercises_slug_uq` ON `exercises` (`slug`);--> statement-breakpoint
CREATE TABLE `goals` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`member_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`baseline` real NOT NULL,
	`target` real NOT NULL,
	`unit` text NOT NULL,
	`target_date` text NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`coach_id` text,
	`ref_exercise_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `goals_member_idx` ON `goals` (`member_id`,`state`);--> statement-breakpoint
CREATE TABLE `habit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`habit_id` text NOT NULL,
	`member_id` text NOT NULL,
	`on_date` text NOT NULL,
	`value` real NOT NULL,
	`client_id` text NOT NULL,
	`logged_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `habit_logs_uq` ON `habit_logs` (`habit_id`,`on_date`);--> statement-breakpoint
CREATE UNIQUE INDEX `habit_logs_client_uq` ON `habit_logs` (`member_id`,`client_id`);--> statement-breakpoint
CREATE TABLE `habits` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`member_id` text NOT NULL,
	`name` text NOT NULL,
	`icon` text DEFAULT 'dot' NOT NULL,
	`cadence` text DEFAULT 'daily' NOT NULL,
	`target` real NOT NULL,
	`unit` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `habits_member_idx` ON `habits` (`member_id`,`active`);--> statement-breakpoint
CREATE TABLE `measurements` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`member_id` text NOT NULL,
	`taken_on` text NOT NULL,
	`weight_kg` real,
	`body_fat_pct` real,
	`lean_mass_kg` real,
	`chest_cm` real,
	`waist_cm` real,
	`hips_cm` real,
	`arm_cm` real,
	`thigh_cm` real,
	`source` text DEFAULT 'self' NOT NULL,
	`outlier` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `measurements_uq` ON `measurements` (`member_id`,`taken_on`);--> statement-breakpoint
CREATE TABLE `nutrition_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`member_id` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`kcal` integer,
	`protein_g` integer,
	`carbs_g` integer,
	`fat_g` integer,
	`water_target_ml` integer DEFAULT 3000 NOT NULL,
	`set_by_id` text,
	`set_by_name` text,
	`safety_flag` text,
	`exclusions` text NOT NULL,
	`allergies` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nutrition_targets_member_id_unique` ON `nutrition_targets` (`member_id`);--> statement-breakpoint
CREATE TABLE `personal_records` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`member_id` text NOT NULL,
	`exercise_id` text NOT NULL,
	`kind` text NOT NULL,
	`value` real NOT NULL,
	`display` text NOT NULL,
	`previous_value` real,
	`previous_display` text,
	`workout_set_id` text,
	`achieved_at` integer NOT NULL,
	`shared` integer DEFAULT false NOT NULL,
	`retired_at` integer
);
--> statement-breakpoint
CREATE INDEX `prs_member_idx` ON `personal_records` (`member_id`,`exercise_id`,`kind`);--> statement-breakpoint
CREATE TABLE `program_days` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`program_id` text NOT NULL,
	`week` integer NOT NULL,
	`day_index` integer NOT NULL,
	`label` text NOT NULL,
	`focus` text NOT NULL,
	`is_rest` integer DEFAULT false NOT NULL,
	`estimated_min` integer DEFAULT 45 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `program_days_idx` ON `program_days` (`program_id`,`week`,`day_index`);--> statement-breakpoint
CREATE TABLE `program_items` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`program_day_id` text NOT NULL,
	`order_index` integer NOT NULL,
	`exercise_id` text NOT NULL,
	`sets` text NOT NULL,
	`target_label` text NOT NULL,
	`superset_group` text,
	`tempo` text,
	`notes` text,
	`rationale` text,
	`trainer_locked` integer DEFAULT false NOT NULL,
	`allowed_substitution_ids` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `program_items_idx` ON `program_items` (`program_day_id`,`order_index`);--> statement-breakpoint
CREATE TABLE `programs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`goal` text NOT NULL,
	`days_per_week` integer NOT NULL,
	`weeks` integer NOT NULL,
	`author_id` text,
	`author_name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`state` text DEFAULT 'published' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `programs_tenant_idx` ON `programs` (`tenant_id`,`state`);--> statement-breakpoint
CREATE TABLE `progress_photos` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`member_id` text NOT NULL,
	`taken_on` text NOT NULL,
	`pose` text NOT NULL,
	`storage_key` text,
	`visibility` text DEFAULT 'private' NOT NULL,
	`consent_given` integer DEFAULT false NOT NULL,
	`pending` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `photos_member_idx` ON `progress_photos` (`member_id`,`taken_on`);--> statement-breakpoint
CREATE TABLE `weekly_check_ins` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`member_id` text NOT NULL,
	`week_start` text NOT NULL,
	`adherence` integer,
	`energy` integer,
	`hunger` integer,
	`sleep` integer,
	`soreness` integer,
	`mood` integer,
	`note` text DEFAULT '' NOT NULL,
	`submitted_at` integer,
	`coach_reply` text,
	`coach_replied_at` integer,
	`safety_escalated` integer DEFAULT false NOT NULL,
	`safety_signals` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `weekly_checkins_uq` ON `weekly_check_ins` (`member_id`,`week_start`);--> statement-breakpoint
CREATE TABLE `workout_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`workout_id` text NOT NULL,
	`member_id` text NOT NULL,
	`client_id` text NOT NULL,
	`exercise_id` text NOT NULL,
	`order_index` integer NOT NULL,
	`set_index` integer NOT NULL,
	`weight_kg` real NOT NULL,
	`reps` integer NOT NULL,
	`rpe` real,
	`is_warmup` integer DEFAULT false NOT NULL,
	`done_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workout_sets_client_uq` ON `workout_sets` (`member_id`,`client_id`);--> statement-breakpoint
CREATE INDEX `workout_sets_workout_idx` ON `workout_sets` (`workout_id`,`order_index`,`set_index`);--> statement-breakpoint
CREATE INDEX `workout_sets_exercise_idx` ON `workout_sets` (`member_id`,`exercise_id`,`done_at`);--> statement-breakpoint
CREATE TABLE `workouts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`branch_id` text,
	`member_id` text NOT NULL,
	`assignment_id` text,
	`program_day_id` text,
	`client_id` text NOT NULL,
	`title` text NOT NULL,
	`state` text DEFAULT 'in_progress' NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`duration_sec` integer DEFAULT 0 NOT NULL,
	`volume_kg` real DEFAULT 0 NOT NULL,
	`total_sets` integer DEFAULT 0 NOT NULL,
	`notes` text,
	`session_rpe` real,
	`substitutions` text NOT NULL,
	`coach_note` text,
	`reviewed_by_trainer_at` integer,
	`synced_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workouts_client_uq` ON `workouts` (`member_id`,`client_id`);--> statement-breakpoint
CREATE INDEX `workouts_member_idx` ON `workouts` (`member_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `achievements` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`tier` text DEFAULT 'bronze' NOT NULL,
	`criteria` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `achievements_code_unique` ON `achievements` (`code`);--> statement-breakpoint
CREATE TABLE `blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`member_id` text NOT NULL,
	`blocked_member_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `blocks_uq` ON `blocks` (`member_id`,`blocked_member_id`);--> statement-breakpoint
CREATE TABLE `challenge_participants` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`challenge_id` text NOT NULL,
	`member_id` text NOT NULL,
	`team_id` text,
	`raw_count` integer DEFAULT 0 NOT NULL,
	`score` integer DEFAULT 0 NOT NULL,
	`joined_at` integer NOT NULL,
	`anonymous` integer DEFAULT false NOT NULL,
	`flagged` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `challenge_participants_uq` ON `challenge_participants` (`challenge_id`,`member_id`);--> statement-breakpoint
CREATE INDEX `challenge_score_idx` ON `challenge_participants` (`challenge_id`,`score`);--> statement-breakpoint
CREATE TABLE `challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`branch_id` text,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`metric` text NOT NULL,
	`metric_label` text NOT NULL,
	`starts_on` text NOT NULL,
	`ends_on` text NOT NULL,
	`visibility` text DEFAULT 'branch' NOT NULL,
	`team_mode` integer DEFAULT false NOT NULL,
	`team_target` integer,
	`rules` text NOT NULL,
	`reward_label` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `challenges_tenant_idx` ON `challenges` (`tenant_id`,`ends_on`);--> statement-breakpoint
CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`post_id` text NOT NULL,
	`member_id` text NOT NULL,
	`body` text NOT NULL,
	`state` text DEFAULT 'visible' NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `comments_post_idx` ON `comments` (`post_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `content_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`reporter_id` text NOT NULL,
	`reason` text NOT NULL,
	`note` text,
	`state` text DEFAULT 'open' NOT NULL,
	`resolved_by_id` text,
	`resolution` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `content_reports_idx` ON `content_reports` (`tenant_id`,`state`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`kind` text DEFAULT 'coach' NOT NULL,
	`title` text NOT NULL,
	`member_id` text,
	`staff_id` text,
	`ticket_id` text,
	`state` text DEFAULT 'open' NOT NULL,
	`muted` integer DEFAULT false NOT NULL,
	`last_message_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `conversations_member_idx` ON `conversations` (`member_id`,`last_message_at`);--> statement-breakpoint
CREATE TABLE `live_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`class_session_id` text,
	`title` text NOT NULL,
	`trainer_name` text NOT NULL,
	`starts_at` integer NOT NULL,
	`state` text DEFAULT 'scheduled' NOT NULL,
	`provider` text DEFAULT 'none' NOT NULL,
	`room_key` text,
	`recording_policy` text DEFAULT 'none' NOT NULL,
	`recording_consent_given` integer DEFAULT false NOT NULL,
	`participant_count` integer DEFAULT 0 NOT NULL,
	`fallback_note` text
);
--> statement-breakpoint
CREATE INDEX `live_tenant_idx` ON `live_sessions` (`tenant_id`,`starts_at`);--> statement-breakpoint
CREATE TABLE `media_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`title` text NOT NULL,
	`category` text NOT NULL,
	`trainer_name` text NOT NULL,
	`duration_sec` integer NOT NULL,
	`level` text DEFAULT 'intermediate' NOT NULL,
	`equipment` text NOT NULL,
	`poster_color` text DEFAULT '#0b2331' NOT NULL,
	`has_captions` integer DEFAULT true NOT NULL,
	`required_product_kinds` text NOT NULL,
	`playback_url` text,
	`published_at` integer NOT NULL,
	`expires_at` integer
);
--> statement-breakpoint
CREATE INDEX `media_tenant_idx` ON `media_assets` (`tenant_id`,`category`);--> statement-breakpoint
CREATE TABLE `media_progress` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`member_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`position_sec` integer DEFAULT 0 NOT NULL,
	`favourite` integer DEFAULT false NOT NULL,
	`completed_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_progress_uq` ON `media_progress` (`member_id`,`asset_id`);--> statement-breakpoint
CREATE TABLE `member_achievements` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`member_id` text NOT NULL,
	`achievement_id` text NOT NULL,
	`earned_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_achievements_uq` ON `member_achievements` (`member_id`,`achievement_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`sender_user_id` text NOT NULL,
	`sender_name` text NOT NULL,
	`sender_role` text NOT NULL,
	`body` text NOT NULL,
	`attachments` text NOT NULL,
	`state` text DEFAULT 'sent' NOT NULL,
	`client_id` text,
	`created_at` integer NOT NULL,
	`read_at` integer,
	`safety_flagged` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `messages_conversation_idx` ON `messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_client_uq` ON `messages` (`conversation_id`,`client_id`);--> statement-breakpoint
CREATE TABLE `posts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`branch_id` text,
	`member_id` text,
	`staff_id` text,
	`author_kind` text DEFAULT 'member' NOT NULL,
	`kind` text DEFAULT 'text' NOT NULL,
	`body` text NOT NULL,
	`badge` text,
	`ref_type` text,
	`ref_id` text,
	`visibility` text DEFAULT 'branch' NOT NULL,
	`state` text DEFAULT 'visible' NOT NULL,
	`kudos_count` integer DEFAULT 0 NOT NULL,
	`comment_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `posts_feed_idx` ON `posts` (`tenant_id`,`branch_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `reactions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`post_id` text NOT NULL,
	`member_id` text NOT NULL,
	`kind` text DEFAULT 'kudos' NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reactions_uq` ON `reactions` (`post_id`,`member_id`,`kind`);--> statement-breakpoint
CREATE TABLE `referrals` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`member_id` text NOT NULL,
	`code` text NOT NULL,
	`invitee_name` text,
	`invitee_contact` text,
	`state` text DEFAULT 'invited' NOT NULL,
	`reward_minor` integer DEFAULT 0 NOT NULL,
	`reward_paid_at` integer,
	`expires_on` text,
	`device_fingerprint` text,
	`suspicious_reason` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `referrals_code_uq` ON `referrals` (`tenant_id`,`code`,`invitee_contact`);--> statement-breakpoint
CREATE INDEX `referrals_member_idx` ON `referrals` (`member_id`);--> statement-breakpoint
CREATE TABLE `streaks` (
	`member_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`current` integer DEFAULT 0 NOT NULL,
	`longest` integer DEFAULT 0 NOT NULL,
	`weekly_target` integer DEFAULT 4 NOT NULL,
	`rest_days_allowed` integer DEFAULT 2 NOT NULL,
	`last_session_on` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `usage_meters` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`meter` text NOT NULL,
	`period` text NOT NULL,
	`used` integer DEFAULT 0 NOT NULL,
	`limit_value` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_meters_uq` ON `usage_meters` (`tenant_id`,`meter`,`period`);--> statement-breakpoint
CREATE TABLE `xp_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`member_id` text NOT NULL,
	`delta` integer NOT NULL,
	`reason` text NOT NULL,
	`ref_type` text,
	`ref_id` text,
	`is_correction` integer DEFAULT false NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `xp_member_idx` ON `xp_ledger` (`member_id`,`at`);--> statement-breakpoint
CREATE UNIQUE INDEX `xp_source_uq` ON `xp_ledger` (`member_id`,`reason`,`ref_type`,`ref_id`,`is_correction`);