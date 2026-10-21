-- No clock expiry: an interrupted provider action requires reconciliation,
-- rather than permitting a deletion or competing checkout to overtake it.
CREATE TABLE account_operation (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('checkout','delete'))
);
