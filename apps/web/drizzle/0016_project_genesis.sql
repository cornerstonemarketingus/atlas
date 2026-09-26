CREATE TABLE IF NOT EXISTS `genesis_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` integer NOT NULL REFERENCES `tenants`(`id`),
	`requested_by` text NOT NULL,
	`prompt` text NOT NULL,
	`name` text NOT NULL,
	`requirements_json` text NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`repository` text,
	`preview_url` text,
	`deployment_url` text,
	`evidence_json` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `genesis_projects_tenant_updated_idx` ON `genesis_projects` (`tenant_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `genesis_projects_requester_idx` ON `genesis_projects` (`requested_by`,`created_at`);