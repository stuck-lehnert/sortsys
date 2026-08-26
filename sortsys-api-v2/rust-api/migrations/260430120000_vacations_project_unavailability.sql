ALTER TABLE users
ADD COLUMN IF NOT EXISTS supervisor_user_id BIGINT REFERENCES users (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_supervisor_user_id ON users (supervisor_user_id);

ALTER TABLE users
DROP CONSTRAINT IF EXISTS users_supervisor_user_not_self;

ALTER TABLE users
ADD CONSTRAINT users_supervisor_user_not_self CHECK (
  supervisor_user_id IS NULL
  OR supervisor_user_id <> id
);

CREATE TABLE user_vacations (
  id BIGINT PRIMARY KEY DEFAULT id64 (),
  user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  requested_by_user_id BIGINT REFERENCES users (id) ON DELETE SET NULL,
  decided_by_user_id BIGINT REFERENCES users (id) ON DELETE SET NULL,
  "from" DATE NOT NULL,
  "to" DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'denied')),
  note VARCHAR(255),
  denial_reason VARCHAR(255),
  decided_at TIMESTAMPTZ,
  CHECK ("from" <= "to")
);

ALTER TABLE user_vacations
ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON user_vacations (created_at);

ALTER TABLE user_vacations
ADD COLUMN modified_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON user_vacations (modified_at);

CREATE TRIGGER user_vacations_modified_at
BEFORE UPDATE ON user_vacations FOR EACH ROW
EXECUTE FUNCTION trigger_modified_at ();

CREATE INDEX ON user_vacations (user_id);

CREATE INDEX ON user_vacations ("from");

CREATE INDEX ON user_vacations ("to");

CREATE INDEX ON user_vacations (status);

CREATE INDEX ON user_vacations (requested_by_user_id);

CREATE INDEX ON user_vacations (decided_by_user_id);

CREATE TABLE project_unavailability_periods (
  id BIGINT PRIMARY KEY DEFAULT id64 (),
  project_id BIGINT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  created_by_user_id BIGINT REFERENCES users (id) ON DELETE SET NULL,
  "from" DATE NOT NULL,
  "to" DATE NOT NULL,
  reason VARCHAR(127) NOT NULL,
  note VARCHAR(255),
  CHECK ("from" <= "to")
);

ALTER TABLE project_unavailability_periods
ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON project_unavailability_periods (created_at);

ALTER TABLE project_unavailability_periods
ADD COLUMN modified_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON project_unavailability_periods (modified_at);

CREATE TRIGGER project_unavailability_periods_modified_at
BEFORE UPDATE ON project_unavailability_periods FOR EACH ROW
EXECUTE FUNCTION trigger_modified_at ();

CREATE INDEX ON project_unavailability_periods (project_id);

CREATE INDEX ON project_unavailability_periods ("from");

CREATE INDEX ON project_unavailability_periods ("to");

CREATE INDEX ON project_unavailability_periods (created_by_user_id);

INSERT INTO
  user_roles (name)
VALUES
  ('view:userVacations'),
  ('manage:userVacations'),
  ('delete:userVacations')
ON CONFLICT DO NOTHING;
