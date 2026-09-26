CREATE TABLE IF NOT EXISTS `request_rate_limits` (
	`subject` text NOT NULL,
	`route` text NOT NULL,
	`bucket_start` integer NOT NULL,
	`request_count` integer NOT NULL DEFAULT 1,
	`updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `request_rate_limits_subject_route_bucket_idx` ON `request_rate_limits` (`subject`,`route`,`bucket_start`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `request_rate_limits_updated_at_idx` ON `request_rate_limits` (`updated_at`);
