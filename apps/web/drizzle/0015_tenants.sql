-- Tenancy (blueprint §15 / Phase 9, SECURITY-REVIEW gap #1, issue #71).
--
-- Adds `tenants` and `tenant_members`, and a nullable `tenant_id` on
-- repositories, tasks, conversations, computer_devices and computer_approvals.
-- Every pre-existing row is backfilled to ONE default tenant (slug 'default')
-- owned by the deployment owner (principal 'operator'), and every existing
-- user becomes a 'member' of it, so nobody loses their history. Users who sign
-- up afterwards get their own personal tenant (created on first request).
--
-- The repository unique key becomes (tenant_id, owner, name): the allowlist
-- and merge policy are per tenant. Do not re-run 0012 after this migration; it
-- would recreate the old global (owner, name) unique index.
--
-- Apply BEFORE deploying the Worker that reads tenant_id. ALTER TABLE ADD
-- COLUMN makes the file as a whole not re-runnable; the backfills are.
CREATE TABLE IF NOT EXISTS `tenants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'personal' NOT NULL,
	`owner_principal` text NOT NULL,
	`personal_user_id` integer REFERENCES `users`(`id`),
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `tenants_slug_idx` ON `tenants` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `tenants_personal_user_idx` ON `tenants` (`personal_user_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `tenant_members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tenant_id` integer NOT NULL REFERENCES `tenants`(`id`),
	`user_id` integer NOT NULL REFERENCES `users`(`id`),
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `tenant_members_tenant_user_idx` ON `tenant_members` (`tenant_id`,`user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tenant_members_user_idx` ON `tenant_members` (`user_id`);--> statement-breakpoint
ALTER TABLE `repositories` ADD `tenant_id` integer REFERENCES `tenants`(`id`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `tenant_id` integer REFERENCES `tenants`(`id`);--> statement-breakpoint
ALTER TABLE `conversations` ADD `tenant_id` integer REFERENCES `tenants`(`id`);--> statement-breakpoint
ALTER TABLE `computer_devices` ADD `tenant_id` integer REFERENCES `tenants`(`id`);--> statement-breakpoint
ALTER TABLE `computer_approvals` ADD `tenant_id` integer REFERENCES `tenants`(`id`);--> statement-breakpoint
INSERT OR IGNORE INTO `tenants` (`slug`, `name`, `kind`, `owner_principal`) VALUES ('default', 'Default workspace', 'default', 'operator');--> statement-breakpoint
INSERT OR IGNORE INTO `tenant_members` (`tenant_id`, `user_id`, `role`)
	SELECT (SELECT `id` FROM `tenants` WHERE `slug` = 'default'), `id`, 'member' FROM `users`;--> statement-breakpoint
UPDATE `repositories` SET `tenant_id` = (SELECT `id` FROM `tenants` WHERE `slug` = 'default') WHERE `tenant_id` IS NULL;--> statement-breakpoint
UPDATE `tasks` SET `tenant_id` = (SELECT `id` FROM `tenants` WHERE `slug` = 'default') WHERE `tenant_id` IS NULL;--> statement-breakpoint
UPDATE `conversations` SET `tenant_id` = (SELECT `id` FROM `tenants` WHERE `slug` = 'default') WHERE `tenant_id` IS NULL;--> statement-breakpoint
UPDATE `computer_devices` SET `tenant_id` = (SELECT `id` FROM `tenants` WHERE `slug` = 'default') WHERE `tenant_id` IS NULL;--> statement-breakpoint
UPDATE `computer_approvals` SET `tenant_id` = (SELECT `id` FROM `tenants` WHERE `slug` = 'default') WHERE `tenant_id` IS NULL;--> statement-breakpoint
DROP INDEX IF EXISTS `repositories_owner_name_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `repositories_tenant_owner_name_idx` ON `repositories` (`tenant_id`,`owner`,`name`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tasks_tenant_requested_by_created_at_idx` ON `tasks` (`tenant_id`,`requested_by`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `conversations_tenant_owner_updated_idx` ON `conversations` (`tenant_id`,`requested_by`,`updated_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `computer_devices_tenant_idx` ON `computer_devices` (`tenant_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `computer_approvals_tenant_idx` ON `computer_approvals` (`tenant_id`);
