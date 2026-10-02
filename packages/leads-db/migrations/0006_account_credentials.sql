-- T6a: one write-only core RPC credential per account. Store only SHA-256 hex digests.
CREATE TABLE IF NOT EXISTS account_credentials (
  account         TEXT PRIMARY KEY,
  credential_hash TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  rotated_at      TEXT
);
