CREATE TABLE `activity_tokens` (
	`tap_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`token` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `push_registrations` (
	`credential_id` text PRIMARY KEY,
	`environment` text NOT NULL,
	`topic` text NOT NULL,
	`device_token` text,
	`start_token` text,
	`live_activities` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activity_tokens_tap_device` ON `activity_tokens` (`tap_id`,`credential_id`);