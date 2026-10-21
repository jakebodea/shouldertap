CREATE TABLE account_resource (
  kind TEXT NOT NULL CHECK(kind IN ('inbox','sender','patron')),
  id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  inbox_id TEXT,
  credential_id TEXT,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(kind, id)
);
CREATE INDEX account_resource_user ON account_resource(user_id);
CREATE TABLE account_preference (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  default_inbox_id TEXT
);
