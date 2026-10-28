CREATE TABLE verification_push (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE TABLE verification_push_result (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status INTEGER NOT NULL,
  reason TEXT
);
