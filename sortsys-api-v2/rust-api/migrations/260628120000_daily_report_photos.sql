CREATE TABLE daily_project_report_files (
  report_id BIGINT NOT NULL REFERENCES daily_project_reports (id) ON DELETE CASCADE,
  project_file_id BIGINT NOT NULL REFERENCES project_files (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (report_id, project_file_id)
);

CREATE INDEX ON daily_project_report_files (project_file_id);
