CREATE TABLE `installations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`github_installation_id` integer NOT NULL,
	`account_login` text NOT NULL,
	`account_type` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `installations_github_installation_id_idx` ON `installations` (`github_installation_id`);--> statement-breakpoint
CREATE TABLE `repositories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`installation_id` integer,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`merge_policy` text DEFAULT 'manual' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`installation_id`) REFERENCES `installations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_owner_name_idx` ON `repositories` (`owner`,`name`);