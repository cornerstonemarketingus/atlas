CREATE TABLE `computer_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`requested_by` text NOT NULL,
	`action_hash` text NOT NULL,
	`summary` text NOT NULL,
	`domain` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` text NOT NULL,
	`decided_at` text,
	`consumed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `computer_tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `computer_approvals_task_created_at_idx` ON `computer_approvals` (`task_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `computer_approvals_owner_status_idx` ON `computer_approvals` (`requested_by`,`status`);--> statement-breakpoint
CREATE TABLE `computer_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`requested_by` text NOT NULL,
	`name` text NOT NULL,
	`platform` text DEFAULT 'windows' NOT NULL,
	`secret_hash` text NOT NULL,
	`status` text DEFAULT 'offline' NOT NULL,
	`last_seen_at` text,
	`revoked_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `computer_devices_owner_created_at_idx` ON `computer_devices` (`requested_by`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `computer_devices_secret_hash_idx` ON `computer_devices` (`secret_hash`);--> statement-breakpoint
CREATE TABLE `computer_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`requested_by` text NOT NULL,
	`device_id` text NOT NULL,
	`objective` text NOT NULL,
	`start_url` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`result` text,
	`error` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`started_at` text,
	`completed_at` text,
	FOREIGN KEY (`device_id`) REFERENCES `computer_devices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `computer_tasks_owner_created_at_idx` ON `computer_tasks` (`requested_by`,`created_at`);--> statement-breakpoint
CREATE INDEX `computer_tasks_device_status_created_at_idx` ON `computer_tasks` (`device_id`,`status`,`created_at`);