ALTER TABLE tool_trackings
ADD COLUMN continuation_of BIGINT REFERENCES tool_trackings (id) ON DELETE SET NULL;

ALTER TABLE tool_trackings
ADD COLUMN notes TEXT;

CREATE TABLE tool_tracking_transfer_requests (
  id BIGINT PRIMARY KEY DEFAULT id64 (),
  tool_tracking_id BIGINT NOT NULL REFERENCES tool_trackings (id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'denied')),
  transfer_to_user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_by_user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  project_id BIGINT REFERENCES projects (id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX ON tool_tracking_transfer_requests (tool_tracking_id)
WHERE
  status IN ('open', 'accepted');

CREATE INDEX ON tool_tracking_transfer_requests (transfer_to_user_id);

CREATE INDEX ON tool_tracking_transfer_requests (created_by_user_id);

CREATE INDEX ON tool_tracking_transfer_requests (project_id);

CREATE INDEX ON tool_tracking_transfer_requests (tool_tracking_id);

CREATE INDEX ON tool_tracking_transfer_requests (created_at);

ALTER TABLE tool_tracking_transfer_requests
ADD COLUMN _search TSVECTOR GENERATED ALWAYS AS (create_searchable (notes)) STORED;

CREATE INDEX ON tool_tracking_transfer_requests USING GIN (_search);
