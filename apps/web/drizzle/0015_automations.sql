CREATE TABLE IF NOT EXISTS `automations` (
	`id` text PRIMARY KEY NOT NULL,
	`requested_by` text NOT NULL,
	`user_id` integer,
	`name` text NOT NULL,
	`repository` text NOT NULL,
	`branch` text NOT NULL,
	`mode` text NOT NULL,
	`objective` text NOT NULL,
	`trigger_type` text NOT NULL,
	`trigger_config` text NOT NULL,
	`budget_limit` integer NOT NULL DEFAULT 1,
	`budget_window_days` integer NOT NULL DEFAULT 7,
	`paused_at` text,
	`created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `automations_owner_created_at_idx` ON `automations` (`requested_by`,`created_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `automation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`automation_id` text NOT NULL,
	`requested_by` text NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`task_id` text,
	`dedupe_key` text,
	`triggered_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`automation_id`) REFERENCES `automations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `automation_runs_automation_triggered_at_idx` ON `automation_runs` (`automation_id`,`triggered_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `automation_runs_automation_dedupe_idx` ON `automation_runs` (`automation_id`,`dedupe_key`);
