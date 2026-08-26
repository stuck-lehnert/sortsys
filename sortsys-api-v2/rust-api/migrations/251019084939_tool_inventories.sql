CREATE TABLE tool_inventories (
  id BIGINT PRIMARY KEY DEFAULT id64 (),
  tool_id BIGINT NOT NULL REFERENCES tools (id) ON DELETE CASCADE,
  comment VARCHAR(511)
);

ALTER TABLE tool_inventories
ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON tool_inventories (created_at);

ALTER TABLE tool_inventories
ADD COLUMN _search TSVECTOR GENERATED ALWAYS AS (create_searchable (comment)) STORED;

CREATE INDEX ON tool_inventories USING GIN (_search);

CREATE INDEX ON tool_inventories (tool_id);
