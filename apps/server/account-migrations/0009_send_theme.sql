-- The theme taps to this person go in, chosen per connection. NULL follows
-- the sending device's own style. Saving it checks nothing: whether a theme
-- is allowed is decided when each tap is sent.
ALTER TABLE account_resource ADD COLUMN send_theme TEXT;
-- 1 on the inviter's half of a connection their accepted invite made, until
-- they choose how that person sees them (or skip): their app asks once.
ALTER TABLE account_resource ADD COLUMN choose_seen_as INTEGER;
