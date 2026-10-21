CREATE TABLE `appearance` (
	`id` integer PRIMARY KEY,
	`theme` text DEFAULT 'default' NOT NULL,
	`motion` text DEFAULT 'system' NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	CONSTRAINT "appearance_single_row" CHECK("id" = 1),
	CONSTRAINT "appearance_theme" CHECK("theme" in ('default', 'broadsheet', 'billboard', 'terminal', 'note')),
	CONSTRAINT "appearance_motion" CHECK("motion" in ('system', 'reduced'))
);
