CREATE TABLE IF NOT EXISTS `revoked_sessions` (
	`sid` text PRIMARY KEY NOT NULL,
	`principal` text NOT NULL,
	`revoked_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `revoked_sessions_expires_at_idx` ON `revoked_sessions` (`expires_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `session_revocations` (
	`principal` text PRIMARY KEY NOT NULL,
	`revoked_before` integer NOT NULL,
	`updated_at` text NOT NULL
);
