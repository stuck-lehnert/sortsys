CREATE TABLE daily_project_reports (
  id BIGINT PRIMARY KEY DEFAULT id64 (),
  project_id BIGINT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  DAY DATE NOT NULL,
  summary TEXT NOT NULL,
  weather JSONB,
  created_by_user_id BIGINT REFERENCES users (id) ON DELETE SET NULL,
  UNIQUE (project_id, DAY)
);

CREATE INDEX ON daily_project_reports (DAY);

CREATE INDEX ON daily_project_reports (created_by_user_id);

ALTER TABLE daily_project_reports
ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON daily_project_reports (created_at);

CREATE TABLE daily_project_report_work_hours (
  id BIGINT PRIMARY KEY DEFAULT id64 (),
  report_id BIGINT NOT NULL REFERENCES daily_project_reports (id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES users (id) ON DELETE SET NULL,
  hours DOUBLE PRECISION NOT NULL,
  cost_per_hour DOUBLE PRECISION
);

CREATE INDEX ON daily_project_report_work_hours (report_id);

CREATE INDEX ON daily_project_report_work_hours (user_id);

INSERT INTO
  user_roles (name)
VALUES
  ('view:dailyProjectReports'),
  ('manage:dailyProjectReports'),
  ('delete:dailyProjectReports')
ON CONFLICT DO NOTHING;
