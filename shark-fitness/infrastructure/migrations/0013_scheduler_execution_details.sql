ALTER TABLE `job_runs` ADD `summary` text;--> statement-breakpoint
ALTER TABLE `job_runs` ADD `error_category` text;--> statement-breakpoint
ALTER TABLE `job_runs` ADD `build_id` text;--> statement-breakpoint
CREATE INDEX `job_runs_outcome_idx` ON `job_runs` (`job`,`status`,`finished_at`);