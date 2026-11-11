-- Public identities and ciphertext only. Private client and recovery keys must
-- never be added to these tables or derived from an operator-held secret.
CREATE TABLE __zerotrust_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  phase TEXT NOT NULL CHECK (phase IN ('unenrolled', 'enrolling', 'active', 'recovery_prepared', 'rekeying')),
  generation BIGINT NOT NULL DEFAULT 1 CHECK (generation > 0),
  policy_version BIGINT NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  catalog_version BIGINT NOT NULL DEFAULT 1 CHECK (catalog_version > 0),
  authority_key BYTEA CHECK (authority_key IS NULL OR octet_length(authority_key) = 32),
  recovery_encryption_key BYTEA CHECK (recovery_encryption_key IS NULL OR octet_length(recovery_encryption_key) = 32),
  recovery_signing_key BYTEA CHECK (recovery_signing_key IS NULL OR octet_length(recovery_signing_key) = 32),
  recovery_operation TEXT,
  recovery_plan JSONB,
  protected_profile JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO __zerotrust_state(singleton, phase) VALUES(TRUE, 'unenrolled');

CREATE TABLE __zerotrust_authorities (
  generation BIGINT PRIMARY KEY CHECK (generation > 0),
  certificate JSONB NOT NULL CHECK (jsonb_typeof(certificate)='object'),
  transition JSONB CHECK (transition IS NULL OR jsonb_typeof(transition)='object')
);

CREATE TABLE __zerotrust_identity_history (
  subject TEXT NOT NULL,
  generation BIGINT NOT NULL REFERENCES __zerotrust_authorities(generation),
  signing_key BYTEA NOT NULL CHECK (octet_length(signing_key)=32),
  certificate JSONB NOT NULL CHECK (jsonb_typeof(certificate)='object'),
  PRIMARY KEY(subject,generation,signing_key)
);

CREATE TABLE __zerotrust_accounts (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  opaque_record BYTEA NOT NULL CHECK (octet_length(opaque_record) BETWEEN 64 AND 4096),
  account_vault JSONB NOT NULL CHECK (jsonb_typeof(account_vault) = 'object'),
  encryption_key BYTEA NOT NULL CHECK (octet_length(encryption_key) = 32),
  signing_key BYTEA NOT NULL CHECK (octet_length(signing_key) = 32),
  identity_certificate JSONB NOT NULL CHECK (jsonb_typeof(identity_certificate) = 'object'),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE __zerotrust_devices (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 192),
  user_id BIGINT NOT NULL REFERENCES __zerotrust_accounts(user_id) ON DELETE CASCADE,
  signing_key BYTEA NOT NULL CHECK (octet_length(signing_key) = 32),
  certificate JSONB NOT NULL CHECK (jsonb_typeof(certificate) = 'object'),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON __zerotrust_devices(user_id);

CREATE TABLE __zerotrust_policies (
  version BIGINT PRIMARY KEY CHECK (version > 0),
  generation BIGINT NOT NULL CHECK (generation > 0),
  policy JSONB NOT NULL CHECK (jsonb_typeof(policy) = 'object'),
  signature BYTEA NOT NULL CHECK (octet_length(signature) = 64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE __zerotrust_domains (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 192),
  scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 192),
  facet TEXT NOT NULL CHECK (facet IN ('scope', 'contract-quantities', 'measurement', 'offer-prices', 'calculation', 'procurement', 'billing', 'master-data', 'personnel', 'attachment')),
  readers_hash BYTEA NOT NULL CHECK (octet_length(readers_hash) = 32),
  generation BIGINT NOT NULL CHECK (generation > 0),
  policy_version BIGINT NOT NULL REFERENCES __zerotrust_policies(version),
  rotation_required BOOLEAN NOT NULL DEFAULT FALSE,
  head_sequence BIGINT NOT NULL DEFAULT 0 CHECK (head_sequence >= 0),
  UNIQUE(scope, facet, readers_hash, generation)
);

CREATE TABLE __zerotrust_key_envelopes (
  domain_id TEXT NOT NULL REFERENCES __zerotrust_domains(id),
  generation BIGINT NOT NULL CHECK (generation > 0),
  recipient TEXT NOT NULL CHECK (length(recipient) BETWEEN 1 AND 192),
  envelope JSONB NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  PRIMARY KEY(domain_id, generation, recipient)
);

CREATE TABLE __zerotrust_service_identities (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 192),
  encryption_key BYTEA NOT NULL CHECK (octet_length(encryption_key) = 32),
  signing_key BYTEA NOT NULL CHECK (octet_length(signing_key) = 32),
  certificate JSONB NOT NULL CHECK (jsonb_typeof(certificate) = 'object'),
  generation BIGINT NOT NULL CHECK (generation > 0),
  revoked_at TIMESTAMPTZ
);

CREATE TABLE __zerotrust_objects (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 192),
  domain_id TEXT NOT NULL REFERENCES __zerotrust_domains(id),
  revision BIGINT NOT NULL CHECK (revision > 0),
  envelope JSONB NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  client_verdict JSONB CHECK (client_verdict IS NULL OR jsonb_typeof(client_verdict) = 'object'),
  deleted_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE __zerotrust_changes (
  seq BIGSERIAL PRIMARY KEY,
  object_id TEXT NOT NULL REFERENCES __zerotrust_objects(id),
  message_id TEXT NOT NULL UNIQUE CHECK (length(message_id) BETWEEN 1 AND 192),
  revision BIGINT NOT NULL CHECK (revision > 0),
  envelope JSONB NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  client_verdict JSONB CHECK (client_verdict IS NULL OR jsonb_typeof(client_verdict) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(object_id, revision)
);
CREATE INDEX ON __zerotrust_objects(domain_id, id COLLATE "C") WHERE deleted_at IS NULL;

CREATE TABLE __zerotrust_recovery_catalog (
  domain_id TEXT NOT NULL REFERENCES __zerotrust_domains(id),
  domain_generation BIGINT NOT NULL CHECK (domain_generation > 0),
  recovery_generation BIGINT NOT NULL CHECK (recovery_generation > 0),
  envelope JSONB NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  PRIMARY KEY(domain_id, domain_generation, recovery_generation)
);

-- This fence also covers old API instances, job runners and document callbacks
-- which do not pass through the new RPC gate. Source rows stay stable while an
-- authorized browser creates their encrypted replacements.
CREATE TABLE __zerotrust_migrations (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 192),
  schema_fingerprint TEXT NOT NULL,
  source_users BIGINT[] NOT NULL,
  phase TEXT NOT NULL DEFAULT 'copying' CHECK(phase IN ('copying','copied','activating','active')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON __zerotrust_migrations ((TRUE));
CREATE TABLE __zerotrust_migration_progress (
  migration_id TEXT NOT NULL REFERENCES __zerotrust_migrations(id),
  table_name TEXT NOT NULL,
  row_count BIGINT NOT NULL CHECK(row_count>=0),
  row_cursor BIGINT NOT NULL DEFAULT 0 CHECK(row_cursor>=0),
  byte_cursor BIGINT NOT NULL DEFAULT 0 CHECK(byte_cursor>=0),
  parts BIGINT NOT NULL DEFAULT 0 CHECK(parts>=0),
  PRIMARY KEY(migration_id,table_name)
);
CREATE TABLE __zerotrust_migration_parts (
  migration_id TEXT NOT NULL REFERENCES __zerotrust_migrations(id),
  table_name TEXT NOT NULL,
  part BIGINT NOT NULL CHECK(part>=0),
  object_id TEXT NOT NULL REFERENCES __zerotrust_objects(id),
  object_revision BIGINT NOT NULL CHECK(object_revision>0),
  receipt JSONB NOT NULL,
  PRIMARY KEY(migration_id,table_name,part),
  UNIQUE(object_id,object_revision)
);

CREATE FUNCTION zerotrust_guard_legacy_write() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE current_phase TEXT;
BEGIN
  -- Authentication changes must not append new plaintext activity records to
  -- the frozen source snapshot. Protected activity uses signed ciphertext.
  IF TG_TABLE_NAME = 'entity_changes' AND TG_OP = 'INSERT' THEN
    SELECT phase INTO current_phase FROM __zerotrust_state WHERE singleton;
    IF current_phase <> 'unenrolled' THEN RETURN NULL; END IF;
  END IF;
  IF current_setting('sortsys.zerotrust_control', TRUE) IN ('recovery', 'erase') THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_TABLE_NAME = 'users' AND TG_OP = 'UPDATE'
     -- Stored generated values are not populated in a BEFORE UPDATE trigger.
     AND (to_jsonb(NEW) - ARRAY['password','totp_uri','username','deactivated_at','archived_at','ui_locale','modified_at','_search'])
       = (to_jsonb(OLD) - ARRAY['password','totp_uri','username','deactivated_at','archived_at','ui_locale','modified_at','_search']) THEN
    RETURN NEW;
  END IF;
  SELECT phase INTO current_phase FROM __zerotrust_state WHERE singleton;
  IF current_phase <> 'unenrolled' THEN
    RAISE EXCEPTION 'Legacy business writes are disabled for this tenant' USING ERRCODE = '55000';
  END IF;
  SELECT phase INTO current_phase FROM __zerotrust_state WHERE singleton FOR SHARE;
  IF current_phase <> 'unenrolled' THEN
    RAISE EXCEPTION 'Legacy business writes are disabled for this tenant' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

DO $$
DECLARE tab RECORD;
BEGIN
  FOR tab IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND c.relname NOT LIKE '\_\_zerotrust\_%' ESCAPE '\'
      AND c.relname NOT IN ('__migrations','user_sessions','user_passkeys','user_roles','user_role_assignments')
  LOOP
    EXECUTE format('CREATE TRIGGER zerotrust_legacy_write BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION zerotrust_guard_legacy_write()',tab.relname);
    EXECUTE format('CREATE TRIGGER zerotrust_legacy_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION zerotrust_guard_legacy_write()',tab.relname);
  END LOOP;
END;
$$;
