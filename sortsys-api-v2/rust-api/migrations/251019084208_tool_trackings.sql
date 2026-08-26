CREATE TABLE tool_trackings (
  id BIGINT PRIMARY KEY DEFAULT id64 (),
  comment VARCHAR(255),
  tool_id BIGINT NOT NULL REFERENCES tools (id) ON DELETE CASCADE,
  responsible_user_id BIGINT REFERENCES users (id) ON DELETE SET NULL,
  project_id BIGINT REFERENCES projects (id) ON DELETE SET NULL,
  started_by_user_id BIGINT REFERENCES users (id) ON DELETE SET NULL,
  ended_by_user_id BIGINT REFERENCES users (id) ON DELETE SET NULL,
  tool_usage_cost_per_day DOUBLE PRECISION,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  deadline_at TIMESTAMPTZ CHECK (
    deadline_at IS NULL
    OR deadline_at >= started_at
  )
);

ALTER TABLE tool_trackings
ADD COLUMN modified_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON tool_trackings (modified_at);

CREATE TRIGGER tool_trackings_modified_at
BEFORE UPDATE ON tool_trackings FOR EACH ROW
EXECUTE FUNCTION trigger_modified_at ();

ALTER TABLE tool_trackings
ADD COLUMN _search TSVECTOR GENERATED ALWAYS AS (create_searchable (comment)) STORED;

CREATE INDEX ON tool_trackings USING GIN (_search);

CREATE UNIQUE INDEX ON tool_trackings (tool_id)
WHERE
  ended_at IS NULL;

CREATE INDEX ON tool_trackings (tool_id);

CREATE INDEX ON tool_trackings (responsible_user_id);

CREATE INDEX ON tool_trackings (project_id);

CREATE INDEX ON tool_trackings (started_by_user_id);

CREATE INDEX ON tool_trackings (ended_by_user_id);

CREATE INDEX ON tool_trackings (started_at);

CREATE INDEX ON tool_trackings (ended_at);

CREATE INDEX ON tool_trackings ((ended_at IS NULL));

CREATE INDEX ON tool_trackings (deadline_at);
