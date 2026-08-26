CREATE TABLE tools (
  id BIGINT PRIMARY KEY DEFAULT id64 (),
  custom_id INT NOT NULL UNIQUE CHECK (custom_id > 0),
  brand VARCHAR(127) NOT NULL,
  category VARCHAR(127) NOT NULL,
  label VARCHAR(255),
  purchase_price DOUBLE PRECISION,
  usage_cost_per_day DOUBLE PRECISION,
  status TEXT CHECK (
    status IS NULL
    OR status IN ('lost', 'broken')
  ),
  archived_since TIMESTAMPTZ,
  created_by_user_id BIGINT REFERENCES users (id)
);

ALTER TABLE tools
ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON tools (created_at);

ALTER TABLE tools
ADD COLUMN modified_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON tools (modified_at);

CREATE TRIGGER tools_modified_at
BEFORE UPDATE ON tools FOR EACH ROW
EXECUTE FUNCTION trigger_modified_at ();

ALTER TABLE tools
ADD COLUMN _search TSVECTOR GENERATED ALWAYS AS (
  create_searchable (custom_id::TEXT, brand, category, label)
) STORED;

CREATE INDEX ON tools USING GIN (_search);

CREATE INDEX ON tools (custom_id);

CREATE INDEX ON tools (brand);

CREATE INDEX ON tools (category);

CREATE INDEX ON tools (status);

CREATE INDEX ON tools ((archived_since IS NULL));

CREATE INDEX ON tools ((archived_since IS NULL), custom_id);
