ALTER TABLE contacts
ADD COLUMN address JSONB;

ALTER TABLE project_contacts
ADD COLUMN label VARCHAR(127);

DROP INDEX IF EXISTS contacts__search_idx;

ALTER TABLE contacts
DROP COLUMN IF EXISTS _search;

ALTER TABLE contacts
ADD COLUMN _search TSVECTOR GENERATED ALWAYS AS (
  create_searchable (
    salutation,
    first_name,
    last_name,
    jsonb_to_search_string (address),
    contact_jsonb_values (phone_numbers, 'number'),
    contact_jsonb_values (email_addresses, 'email')
  )
) STORED;

CREATE INDEX ON contacts USING GIN (_search);
