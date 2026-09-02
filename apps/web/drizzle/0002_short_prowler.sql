CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`user_id` integer,
	`requested_by` text NOT NULL,
	`repository` text NOT NULL,
	`branch` text NOT NULL,
	`mode` text NOT NULL,
	`objective` text NOT NULL,
	`merge_policy` text DEFAULT 'manual' NOT NULL,
	`github_run_id` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_task_id_idx` ON `tasks` (`task_id`);--> statement-breakpoint
CREATE INDEX `tasks_requested_by_created_at_idx` ON `tasks` (`requested_by`,`created_at`);