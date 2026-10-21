CREATE TABLE `patron_events` (`id` text PRIMARY KEY, `event` text NOT NULL);--> statement-breakpoint
CREATE TABLE `patron_checkout` (`id` integer PRIMARY KEY, `request_id` text NOT NULL, `created_at` integer NOT NULL, `url` text, `provider_id` text);--> statement-breakpoint
CREATE TABLE `refunded_orders` (`id` text PRIMARY KEY);--> statement-breakpoint
ALTER TABLE `inbox` ADD `first_answered_at` integer;--> statement-breakpoint
ALTER TABLE `inbox` ADD `answered_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `inbox` ADD `support_ask_after` integer DEFAULT 0 NOT NULL;
