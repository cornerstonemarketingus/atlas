CREATE TABLE `computer_task_events` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`requested_by` text NOT NULL,
	`kind` text NOT NULL,
	`summary` text NOT NULL,
	`detail` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `computer_tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `computer_task_events_task_created_at_idx` ON `computer_task_events` (`task_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `computer_task_events_owner_created_at_idx` ON `computer_task_events` (`requested_by`,`created_at`);--> statement-breakpoint
ALTER TABLE `computer_tasks` ADD `heartbeat_at` text;--> statement-breakpoint
ALTER TABLE `computer_tasks` ADD `lease_expires_at` text;--> statement-breakpoint
ALTER TABLE `computer_tasks` ADD `attempt_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `computer_tasks` SET `status` = 'queued' WHERE `status` = 'running';
