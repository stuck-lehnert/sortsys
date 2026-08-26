CREATE TABLE project_deployments (
  id BIGINT PRIMARY KEY DEFAULT id64 (),
  project_id BIGINT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  "from" TIMESTAMPTZ NOT NULL,
  "to" TIMESTAMPTZ NOT NULL,
  note VARCHAR(255)
);

ALTER TABLE project_deployments
ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON project_deployments (created_at);

CREATE INDEX ON project_deployments (project_id);

CREATE INDEX ON project_deployments (user_id);

CREATE INDEX ON project_deployments ("from");

CREATE INDEX ON project_deployments ("to");
