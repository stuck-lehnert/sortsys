ALTER TABLE customers
ADD COLUMN phone_numbers JSONB NOT NULL DEFAULT '[]'::jsonb,
ADD COLUMN email_addresses JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE customers
DROP COLUMN _search;

ALTER TABLE customers
ADD COLUMN _search TSVECTOR GENERATED ALWAYS AS (
  create_searchable (
    salutation,
    name,
    jsonb_to_search_string (address),
    contact_jsonb_values (phone_numbers, 'number'),
    contact_jsonb_values (email_addresses, 'email')
  )
) STORED;

CREATE INDEX ON customers USING GIN (_search);

CREATE TABLE resource_notes (
  id BIGINT PRIMARY KEY DEFAULT id64 (),
  project_id BIGINT REFERENCES projects (id) ON DELETE CASCADE,
  customer_id BIGINT REFERENCES customers (id) ON DELETE CASCADE,
  tool_id BIGINT REFERENCES tools (id) ON DELETE CASCADE,
  contact_id BIGINT REFERENCES contacts (id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (LENGTH(TRIM(body)) > 0),
  created_by_user_id BIGINT REFERENCES users (id) ON DELETE SET NULL,
  CHECK (
    num_nonnulls (project_id, customer_id, tool_id, contact_id) = 1
  )
);

ALTER TABLE resource_notes
ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON resource_notes (created_at);

ALTER TABLE resource_notes
ADD COLUMN modified_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON resource_notes (modified_at);

CREATE TRIGGER resource_notes_modified_at
BEFORE UPDATE ON resource_notes FOR EACH ROW
EXECUTE FUNCTION trigger_modified_at ();

CREATE INDEX ON resource_notes (project_id, created_at DESC);

CREATE INDEX ON resource_notes (customer_id, created_at DESC);

CREATE INDEX ON resource_notes (tool_id, created_at DESC);

CREATE INDEX ON resource_notes (contact_id, created_at DESC);
