-- How the person appears to each person they tap, chosen per connection.
-- NULL on connections made before this: they show the account profile.
ALTER TABLE account_resource ADD COLUMN send_name TEXT;
ALTER TABLE account_resource ADD COLUMN send_color TEXT;
-- The profile they picked for their latest connection (or saved as their
-- own since): the next connection starts with it. NULL means the account
-- profile.
ALTER TABLE account_preference ADD COLUMN send_name TEXT;
ALTER TABLE account_preference ADD COLUMN send_color TEXT;
