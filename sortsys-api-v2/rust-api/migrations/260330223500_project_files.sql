CREATE TABLE project_files (
  id BIGINT PRIMARY KEY DEFAULT id64 (),
  project_id BIGINT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  storage_bucket TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  file_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(255) NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'file')),
  size_bytes BIGINT CHECK (
    size_bytes IS NULL
    OR size_bytes >= 0
  ),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'uploaded')),
  etag TEXT,
  created_by_user_id BIGINT REFERENCES users (id) ON DELETE SET NULL,
  uploaded_at TIMESTAMPTZ
);

ALTER TABLE project_files
ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON project_files (created_at);

CREATE INDEX ON project_files (project_id);

CREATE INDEX ON project_files (project_id, status, created_at DESC);

CREATE INDEX ON project_files (created_by_user_id);

CREATE INDEX ON project_files (kind);
