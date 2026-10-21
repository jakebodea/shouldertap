CREATE TABLE `patron` (
	`id` integer PRIMARY KEY,
	`patron_id` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "patron_single_row" CHECK("id" = 1)
);
--> statement-breakpoint
CREATE TABLE `patron_checkout` (
	`id` integer PRIMARY KEY,
	`request_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`url` text,
	`provider_id` text
);
--> statement-breakpoint
CREATE TABLE `patron_events` (
	`id` text PRIMARY KEY,
	`event` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `patron_keys` (
	`id` text PRIMARY KEY,
	`secret_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE TABLE `patron_link_codes` (
	`id` text PRIMARY KEY,
	`secret_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`redeemed_at` integer
);
