CREATE TABLE users (
  id BIGINT PRIMARY KEY DEFAULT id64 (),
  salutation VARCHAR(15),
  first_name VARCHAR(127) NOT NULL,
  last_name VARCHAR(127),
  username VARCHAR(63) NOT NULL UNIQUE CHECK (LOWER(username) = username),
  email VARCHAR(127),
  phone VARCHAR(63),
  contract_type TEXT NOT NULL DEFAULT 'internal' CHECK (
    contract_type IN ('internal', 'external', 'subcontractor')
  ),
  cost_per_hour DOUBLE PRECISION CHECK (cost_per_hour >= 0),
  password TEXT,
  totp_uri TEXT,
  deactivated_at TIMESTAMPTZ DEFAULT NOW(),
  archived_at TIMESTAMPTZ CHECK (
    archived_at IS NULL
    OR deactivated_at IS NOT NULL
  ),
  created_by_user_id BIGINT REFERENCES users (id) ON DELETE SET NULL
);

ALTER TABLE users
ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON users (created_at);

ALTER TABLE users
ADD COLUMN modified_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON users (modified_at);

CREATE TRIGGER users_modified_at
BEFORE UPDATE ON users FOR EACH ROW
EXECUTE FUNCTION trigger_modified_at ();

ALTER TABLE users
ADD COLUMN _search TSVECTOR GENERATED ALWAYS AS (
  create_searchable (first_name, last_name, username, email, phone)
) STORED;

CREATE INDEX ON users USING GIN (_search);

CREATE INDEX ON users (contract_type);

CREATE INDEX ON users (deactivated_at, username);

CREATE INDEX ON users (deactivated_at, username);

CREATE TABLE user_sessions (
  id BIGINT PRIMARY KEY DEFAULT id64 (),
  user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  user_agent TEXT,
  inet_addr TEXT,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + '30 days')
);

ALTER TABLE user_sessions
ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON user_sessions (created_at);

CREATE INDEX ON user_sessions (user_id);

CREATE INDEX ON user_sessions (user_id, expires_at);
