CREATE TABLE customers (
  id BIGINT PRIMARY KEY DEFAULT id64 (),
  salutation VARCHAR(15),
  name VARCHAR(127) NOT NULL,
  address JSONB,
  created_by_user_id BIGINT REFERENCES users (id) ON DELETE SET NULL
);

ALTER TABLE customers
ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON customers (created_at);

ALTER TABLE customers
ADD COLUMN modified_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON customers (modified_at);

CREATE TRIGGER customers_modified_at
BEFORE UPDATE ON customers FOR EACH ROW
EXECUTE FUNCTION trigger_modified_at ();

ALTER TABLE customers
ADD COLUMN _search TSVECTOR GENERATED ALWAYS AS (
  create_searchable (
    salutation,
    name,
    jsonb_to_search_string (address)
  )
) STORED;

CREATE INDEX ON customers USING GIN (_search);

CREATE TABLE projects (
  id BIGINT PRIMARY KEY DEFAULT id64 (),
  title VARCHAR(127) NOT NULL,
  address JSONB,
  customer_id BIGINT REFERENCES customers (id) ON DELETE SET NULL,
  finished_at TIMESTAMPTZ,
  created_by_user_id BIGINT REFERENCES users (id) ON DELETE SET NULL
);

ALTER TABLE projects
ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON projects (created_at);

ALTER TABLE projects
ADD COLUMN modified_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON projects (modified_at);

CREATE TRIGGER projects_modified_at
BEFORE UPDATE ON projects FOR EACH ROW
EXECUTE FUNCTION trigger_modified_at ();

ALTER TABLE projects
ADD COLUMN _search TSVECTOR GENERATED ALWAYS AS (
  create_searchable (title, jsonb_to_search_string (address))
) STORED;

CREATE INDEX ON projects USING GIN (_search);

CREATE INDEX ON projects (customer_id);

CREATE INDEX ON projects (LOWER(title));

CREATE INDEX ON projects ((finished_at IS NULL), LOWER(title));

CREATE TABLE project_user_assignments (
  project_id BIGINT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, user_id),
  type TEXT NOT NULL CHECK (type IN ('leader', 'contributor', 'member'))
);

ALTER TABLE project_user_assignments
ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON project_user_assignments (created_at);

CREATE INDEX ON project_user_assignments (project_id);

CREATE INDEX ON project_user_assignments (user_id);

CREATE INDEX ON project_user_assignments (project_id, user_id, type);
