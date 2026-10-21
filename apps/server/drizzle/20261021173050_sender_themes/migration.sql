-- Additive only, hand-trimmed from drizzle-kit's table rebuild: SQLite accepts
-- a named CHECK on an added column, so existing rows keep their place.
ALTER TABLE `appearance` ADD `sender_themes` text DEFAULT 'show' NOT NULL CONSTRAINT "appearance_sender_themes" CHECK("sender_themes" in ('show', 'plain'));--> statement-breakpoint
ALTER TABLE `taps` ADD `theme` text CONSTRAINT "taps_theme" CHECK("theme" IS NULL OR "theme" in ('default', 'broadsheet', 'billboard', 'terminal', 'note'));
