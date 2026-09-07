CREATE TABLE project_file_folders (
    id BIGINT PRIMARY KEY DEFAULT id64 (),
    project_id BIGINT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    parent_folder_id BIGINT,
    name VARCHAR(255) NOT NULL,
    created_by_user_id BIGINT REFERENCES users (id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    modified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (id, project_id),
    CONSTRAINT project_file_folders_parent_fk
        FOREIGN KEY (parent_folder_id, project_id)
        REFERENCES project_file_folders (id, project_id)
        ON DELETE RESTRICT,
    CONSTRAINT project_file_folders_not_own_parent
        CHECK (parent_folder_id IS NULL OR parent_folder_id <> id)
);

CREATE UNIQUE INDEX project_file_folders_sibling_name_idx
    ON project_file_folders (
        project_id,
        COALESCE(parent_folder_id, 0),
        LOWER(name)
    );

CREATE INDEX project_file_folders_project_parent_idx
    ON project_file_folders (project_id, parent_folder_id, LOWER(name));

ALTER TABLE project_files
    ADD COLUMN folder_id BIGINT,
    ADD COLUMN modified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD CONSTRAINT project_files_folder_fk
        FOREIGN KEY (folder_id, project_id)
        REFERENCES project_file_folders (id, project_id)
        ON DELETE RESTRICT;

UPDATE project_files
SET modified_at = COALESCE(office_modified_at, uploaded_at, created_at);

CREATE INDEX project_files_project_folder_idx
    ON project_files (project_id, folder_id, file_name)
    WHERE status = 'uploaded';
