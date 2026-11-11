CREATE TABLE IF NOT EXISTS __opaque_setup (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  server_setup BYTEA NOT NULL
);

-- One-time admission metadata only. No prompts, source files or tool results.
CREATE TABLE IF NOT EXISTS __llm_live_admissions (
  nonce TEXT PRIMARY KEY,
  tenant TEXT NOT NULL REFERENCES __tenants(name) ON DELETE CASCADE,
  session_id BIGINT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS llm_live_admission_expiry ON __llm_live_admissions(expires_at);

CREATE TABLE IF NOT EXISTS __opaque_exchanges (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL REFERENCES __tenants(name) ON DELETE CASCADE,
  username TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('register', 'login')),
  server_state BYTEA,
  account_revision BIGINT,
  user_id BIGINT,
  session_id BIGINT,
  attempt_key BYTEA,
  attempt_expires_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '2 minutes'
);
CREATE INDEX IF NOT EXISTS opaque_exchange_expiry ON __opaque_exchanges(expires_at);

CREATE TABLE IF NOT EXISTS __zerotrust_recovery_heads (
  tenant TEXT PRIMARY KEY REFERENCES __tenants(name) ON DELETE CASCADE,
  generation BIGINT NOT NULL CHECK (generation > 0),
  catalog_version BIGINT NOT NULL CHECK (catalog_version > 0),
  recovery_encryption_key BYTEA NOT NULL CHECK (octet_length(recovery_encryption_key) = 32),
  recovery_signing_key BYTEA NOT NULL CHECK (octet_length(recovery_signing_key) = 32),
  authority_key BYTEA NOT NULL CHECK (octet_length(authority_key) = 32),
  certificate JSONB NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('enrolling', 'active', 'rekeying')),
  operation TEXT,
  prepared_plan JSONB,
  source_phase TEXT CHECK(source_phase IN ('enrolling','active')),
  catalog JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS __zerotrust_recovery_history (
  tenant TEXT NOT NULL REFERENCES __tenants(name) ON DELETE CASCADE,
  generation BIGINT NOT NULL CHECK(generation>1),
  operation TEXT NOT NULL UNIQUE,
  source_phase TEXT NOT NULL CHECK(source_phase IN ('enrolling','active')),
  plan JSONB NOT NULL CHECK(jsonb_typeof(plan)='object'),
  applied_at TIMESTAMPTZ,
  PRIMARY KEY(tenant,generation)
);

CREATE TABLE IF NOT EXISTS __zerotrust_recovery_challenges (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL REFERENCES __zerotrust_recovery_heads(tenant) ON DELETE CASCADE,
  generation BIGINT NOT NULL CHECK (generation > 0),
  nonce BYTEA NOT NULL CHECK (octet_length(nonce) = 32),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '5 minutes'
);
CREATE INDEX IF NOT EXISTS zerotrust_recovery_challenge_expiry ON __zerotrust_recovery_challenges(expires_at);

CREATE TABLE IF NOT EXISTS __zerotrust_recovery_keys (
  tenant TEXT NOT NULL REFERENCES __zerotrust_recovery_heads(tenant) ON DELETE CASCADE,
  domain_id TEXT NOT NULL,
  domain_generation BIGINT NOT NULL CHECK (domain_generation > 0),
  recovery_generation BIGINT NOT NULL CHECK (recovery_generation > 0),
  definition JSONB NOT NULL CHECK (jsonb_typeof(definition)='object'),
  PRIMARY KEY(tenant,domain_id,domain_generation,recovery_generation)
);
