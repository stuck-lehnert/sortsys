-- No tenant FK: nonexistent accounts must receive the same throttling policy.
-- Keyed digests avoid retaining submitted user names or addresses here.
CREATE TABLE IF NOT EXISTS __login_attempts (
  account_key BYTEA PRIMARY KEY CHECK (octet_length(account_key) = 32),
  attempts SMALLINT NOT NULL CHECK (attempts BETWEEN 0 AND 10),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_expiry ON __login_attempts (expires_at);
