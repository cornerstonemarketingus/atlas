ALTER TABLE `computer_tasks` ADD `workflow_type` text DEFAULT 'custom' NOT NULL;--> statement-breakpoint
ALTER TABLE `computer_tasks` ADD `approval_policy` text DEFAULT 'consequential' NOT NULL;