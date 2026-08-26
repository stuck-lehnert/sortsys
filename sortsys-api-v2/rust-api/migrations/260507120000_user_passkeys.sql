CREATE TABLE user_passkeys (
  id BIGINT PRIMARY KEY DEFAULT id64 (),
  user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key_jwk JSONB NOT NULL,
  sign_count BIGINT NOT NULL DEFAULT 0,
  label VARCHAR(160) NOT NULL,
  transports TEXT[] DEFAULT ARRAY[]::TEXT[],
  last_used_at TIMESTAMPTZ
);

ALTER TABLE user_passkeys
ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON user_passkeys (created_at);

ALTER TABLE user_passkeys
ADD COLUMN modified_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON user_passkeys (modified_at);

CREATE TRIGGER user_passkeys_modified_at
BEFORE UPDATE ON user_passkeys FOR EACH ROW
EXECUTE FUNCTION trigger_modified_at ();

CREATE INDEX ON user_passkeys (user_id);

CREATE INDEX ON user_passkeys (credential_id);
