-- Extend the operation gate without rewriting an already-applied migration.
-- Preserve any fail-closed locks left by interrupted Workers.
CREATE TABLE account_operation_next (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('checkout','delete','adopt'))
);
INSERT INTO account_operation_next(user_id,request_id,kind)
  SELECT user_id,request_id,kind FROM account_operation;
DROP TABLE account_operation;
ALTER TABLE account_operation_next RENAME TO account_operation;
