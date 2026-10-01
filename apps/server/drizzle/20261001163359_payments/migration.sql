ALTER TABLE `inbox` ADD `trial_ends_at` integer;--> statement-breakpoint
ALTER TABLE `inbox` ADD `paid_at` integer;--> statement-breakpoint
ALTER TABLE `inbox` ADD `order_id` text;--> statement-breakpoint
ALTER TABLE `inbox` ADD `purchase_email` text;--> statement-breakpoint
-- Inboxes created before payments get a full trial from when they first wake up after this deploy.
UPDATE `inbox` SET `trial_ends_at` = (unixepoch() * 1000) + 604800000 WHERE `trial_ends_at` IS NULL;
