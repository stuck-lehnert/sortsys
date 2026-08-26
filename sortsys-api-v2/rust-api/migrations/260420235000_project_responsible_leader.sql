ALTER TABLE projects
ADD COLUMN responsible_project_leader_user_id BIGINT REFERENCES users (id) ON DELETE SET NULL;

CREATE INDEX ON projects (responsible_project_leader_user_id);
