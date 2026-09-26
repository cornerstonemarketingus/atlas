-- Durable engineering memory for Atlas chat (#82).
--
-- Tenant- and user-scoped saved facts, preferences, conventions, decisions,
-- commands and failures that Atlas can use across conversations. Safe to apply
-- before the Worker code that reads from it; code degrades when the table does
-- not exist yet.
CREATE TABLE IF NOT EXISTS `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` integer NOT NULL REFERENCES `tenants`(`id`),
	`requested_by` text NOT NULL,
	`kind` text NOT NULL CHECK (`kind` IN ('fact', 'preference', 'decision', 'convention', 'failure', 'command')),
	`repository` text,
	`content` text NOT NULL CHECK (length(`content`) <= 1000),
	`source_conversation_id` text REFERENCES `conversations`(`id`),
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_used_at` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `memories_tenant_requested_by_updated_at_idx` ON `memories` (`tenant_id`,`requested_by`,`updated_at`);
