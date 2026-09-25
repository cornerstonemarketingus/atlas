ALTER TABLE `tasks` ADD `correlation_id` text;--> statement-breakpoint
CREATE INDEX `tasks_correlation_id_idx` ON `tasks` (`correlation_id`);
