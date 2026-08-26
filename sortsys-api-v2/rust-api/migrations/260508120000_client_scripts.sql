INSERT INTO
  user_roles (name)
VALUES
  ('view:clientScripts'),
  ('manage:clientScripts'),
  ('delete:clientScripts')
ON CONFLICT (name) DO NOTHING;

CREATE TABLE client_scripts (
  id BIGINT PRIMARY KEY DEFAULT id64 (),
  name VARCHAR(160) NOT NULL,
  description TEXT,
  code TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_user_id BIGINT REFERENCES users (id) ON DELETE SET NULL,
  modified_by_user_id BIGINT REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  _search TSVECTOR GENERATED ALWAYS AS (create_searchable (name, description)) STORED
);

CREATE INDEX ON client_scripts (created_at);

CREATE INDEX ON client_scripts (modified_at);

CREATE INDEX ON client_scripts (enabled);

CREATE INDEX ON client_scripts USING GIN (_search);

CREATE TRIGGER client_scripts_modified_at
BEFORE UPDATE ON client_scripts FOR EACH ROW
EXECUTE FUNCTION trigger_modified_at ();
