CREATE TABLE client_error_reports (
  id BIGINT PRIMARY KEY DEFAULT id64 (),
  level TEXT NOT NULL CHECK (level IN ('error', 'warning')),
  source VARCHAR(128) NOT NULL,
  message TEXT NOT NULL,
  stack TEXT,
  path TEXT,
  component_stack TEXT,
  metadata JSONB,
  user_agent TEXT,
  created_by_user_id BIGINT REFERENCES users (id) ON DELETE SET NULL
);

ALTER TABLE client_error_reports
ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON client_error_reports (created_at);

CREATE INDEX ON client_error_reports (level, created_at DESC);
