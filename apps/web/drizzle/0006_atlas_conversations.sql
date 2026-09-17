CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`requested_by` text NOT NULL,
	`title` text NOT NULL,
	`repository` text NOT NULL,
	`branch` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `conversations_owner_updated_idx` ON `conversations` (`requested_by`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `conversation_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`requested_by` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`attachments_json` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conversation_messages_conversation_idx` ON `conversation_messages` (`conversation_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `run_events` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`task_id` text,
	`requested_by` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`detail` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_events_conversation_idx` ON `run_events` (`conversation_id`,`created_at`);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `conversation_id` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `execution_provider` text DEFAULT 'managed' NOT NULL;
--> statement-breakpoint
CREATE INDEX `tasks_conversation_idx` ON `tasks` (`conversation_id`,`created_at`);
