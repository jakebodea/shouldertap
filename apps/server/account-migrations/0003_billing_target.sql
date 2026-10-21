-- Keep one account's checkout attempts on one billing subject. Never expire an
-- uncertain provider attempt on a clock; a deliberate provider reconciliation
-- must precede any future change of billing subject.
CREATE TABLE account_billing_target (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  patron_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
