ALTER TABLE `credentials` ADD `platform` text;--> statement-breakpoint
-- Every device linked before iPhones could link is a Mac.
UPDATE `credentials` SET `platform` = 'mac' WHERE `kind` = 'device';
