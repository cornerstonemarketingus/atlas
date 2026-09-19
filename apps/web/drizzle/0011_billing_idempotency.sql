CREATE TABLE `billing_events` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`created_at` integer NOT NULL,
	`received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `billing_events_received_at_idx` ON `billing_events` (`received_at`);--> statement-breakpoint
CREATE TABLE `hosted_browser_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`period_start` text NOT NULL,
	`minutes_used` integer DEFAULT 0 NOT NULL,
	`active_sessions` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hosted_browser_usage_user_period_idx` ON `hosted_browser_usage` (`user_id`,`period_start`);--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `last_event_at` integer;
