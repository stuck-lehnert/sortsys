ALTER TABLE project_deployments
ADD COLUMN IF NOT EXISTS modified_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE project_deployments
SET
  modified_at = created_at
WHERE
  modified_at <> created_at;

CREATE INDEX IF NOT EXISTS idx_project_deployments_modified_at ON project_deployments (modified_at);

DROP TRIGGER IF EXISTS project_deployments_modified_at ON project_deployments;

CREATE TRIGGER project_deployments_modified_at
BEFORE UPDATE ON project_deployments FOR EACH ROW
EXECUTE FUNCTION trigger_modified_at ();
