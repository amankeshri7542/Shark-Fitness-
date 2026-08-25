CREATE TABLE `challenge_invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`challenge_id` text NOT NULL,
	`member_id` text NOT NULL,
	`invited_by_user_id` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer,
	`responded_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `challenge_invitations_uq` ON `challenge_invitations` (`challenge_id`,`member_id`);--> statement-breakpoint
CREATE INDEX `challenge_invitations_member_idx` ON `challenge_invitations` (`member_id`,`state`);