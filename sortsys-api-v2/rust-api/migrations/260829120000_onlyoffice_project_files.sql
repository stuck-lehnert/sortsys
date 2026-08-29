ALTER TABLE project_files
    ADD COLUMN office_version BIGINT NOT NULL DEFAULT 1 CHECK (office_version > 0),
    ADD COLUMN office_modified_at TIMESTAMPTZ,
    ADD COLUMN office_modified_by_user_id BIGINT REFERENCES users (id) ON DELETE SET NULL;

CREATE INDEX idx_project_files_office_version
    ON project_files (id, office_version)
    WHERE status = 'uploaded';

CREATE INDEX idx_project_files_office_modified_at
    ON project_files (office_modified_at DESC)
    WHERE office_modified_at IS NOT NULL;

CREATE INDEX idx_project_files_office_modified_by_user
    ON project_files (office_modified_by_user_id)
    WHERE office_modified_by_user_id IS NOT NULL;

COMMENT ON COLUMN project_files.office_version IS
    'Revision used to invalidate completed ONLYOFFICE editing sessions.';

