-- The two answers a person offers on their taps unless they change them on
-- one. No row offers On it and In 10 min.
CREATE TABLE account_quick_replies (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  first TEXT NOT NULL,
  second TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
