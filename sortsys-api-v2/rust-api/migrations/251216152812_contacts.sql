CREATE OR REPLACE FUNCTION contact_jsonb_values (data JSONB, field TEXT) RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $$
  SELECT array_to_string(
    ARRAY(
      SELECT jsonb_extract_path_text(elem, field)
      FROM jsonb_array_elements(COALESCE(data, '[]'::jsonb)) AS elem
      WHERE jsonb_extract_path_text(elem, field) IS NOT NULL
    ),
    ' '
  );
$$;

CREATE TABLE contacts (
  id BIGINT PRIMARY KEY DEFAULT id64 (),
  salutation VARCHAR(31),
  first_name VARCHAR(127) NOT NULL,
  last_name VARCHAR(127),
  phone_numbers JSONB NOT NULL DEFAULT '[]'::jsonb,
  email_addresses JSONB NOT NULL DEFAULT '[]'::jsonb
);

ALTER TABLE contacts
ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON contacts (created_at);

ALTER TABLE contacts
ADD COLUMN modified_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON contacts (modified_at);

CREATE TRIGGER contacts_modified_at
BEFORE UPDATE ON contacts FOR EACH ROW
EXECUTE FUNCTION trigger_modified_at ();

ALTER TABLE contacts
ADD COLUMN _search TSVECTOR GENERATED ALWAYS AS (
  create_searchable (
    salutation,
    first_name,
    last_name,
    contact_jsonb_values (phone_numbers, 'number'),
    contact_jsonb_values (email_addresses, 'email')
  )
) STORED;

CREATE INDEX ON contacts USING GIN (_search);

CREATE TABLE project_contacts (
  project_id BIGINT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  contact_id BIGINT NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, contact_id)
);

CREATE INDEX ON project_contacts (project_id);

CREATE INDEX ON project_contacts (contact_id);

CREATE TABLE customer_contacts (
  customer_id BIGINT NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  contact_id BIGINT NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  PRIMARY KEY (customer_id, contact_id)
);

CREATE INDEX ON customer_contacts (customer_id);

CREATE INDEX ON customer_contacts (contact_id);
