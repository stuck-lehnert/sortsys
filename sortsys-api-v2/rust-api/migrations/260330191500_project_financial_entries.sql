CREATE TABLE project_financial_entries (
  id BIGINT PRIMARY KEY DEFAULT id64 (),
  project_id BIGINT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('offer', 'invoice')),
  amount DOUBLE PRECISION NOT NULL CHECK (amount >= 0),
  comment TEXT,
  created_by_user_id BIGINT REFERENCES users (id) ON DELETE SET NULL
);

ALTER TABLE project_financial_entries
ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON project_financial_entries (created_at);

CREATE INDEX idx_project_financial_entries__project_type_created_at ON project_financial_entries (project_id, type, created_at DESC);

CREATE INDEX idx_project_financial_entries__project_created_at ON project_financial_entries (project_id, created_at DESC);
