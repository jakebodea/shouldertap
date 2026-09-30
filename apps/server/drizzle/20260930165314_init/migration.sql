CREATE TABLE `credentials` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`secret_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE TABLE `inbox` (
	`id` integer PRIMARY KEY,
	`inbox_id` text NOT NULL,
	`recipient_name` text NOT NULL,
	`sequence` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `invites` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`secret_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`redeemed_at` integer
);
--> statement-breakpoint
CREATE TABLE `taps` (
	`id` text PRIMARY KEY,
	`request_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`state` text NOT NULL,
	`displayed_at` integer,
	`acknowledged_at` integer,
	`acknowledged_by` text,
	`response` text,
	`sequence` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tickets` (
	`id` text PRIMARY KEY,
	`secret_hash` text NOT NULL,
	`credential_id` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `taps_sender_request` ON `taps` (`sender_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `taps_created_at` ON `taps` (`created_at`);