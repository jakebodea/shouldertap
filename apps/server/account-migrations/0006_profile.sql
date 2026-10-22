-- The person behind an account: the name and color others see, asked once.
CREATE TABLE account_profile (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
