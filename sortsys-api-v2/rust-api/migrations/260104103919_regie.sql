CREATE TABLE regie_reports (
  id BIGINT PRIMARY KEY DEFAULT id64 (),
  project_id BIGINT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  DAY DATE NOT NULL DEFAULT NOW(),
  summary VARCHAR(4095),
  created_by_user_id BIGINT REFERENCES users (id) ON DELETE CASCADE
);

ALTER TABLE regie_reports
ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON regie_reports (created_at);

CREATE INDEX ON regie_reports (project_id);

CREATE INDEX ON regie_reports (DAY);

CREATE INDEX ON regie_reports (project_id, DAY);

CREATE TABLE regie_report_work_hours (
  id BIGINT PRIMARY KEY DEFAULT id64 (),
  report_id BIGINT NOT NULL REFERENCES regie_reports (id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES users (id) ON DELETE SET NULL,
  hours DOUBLE PRECISION NOT NULL,
  cost_per_hour DOUBLE PRECISION
);

CREATE INDEX ON regie_report_work_hours (report_id);

CREATE INDEX ON regie_report_work_hours (user_id);

CREATE TABLE regie_report_products (
  id BIGINT PRIMARY KEY DEFAULT id64 (),
  report_id BIGINT NOT NULL REFERENCES regie_reports (id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  quantity DOUBLE PRECISION NOT NULL,
  comment VARCHAR(255)
);

CREATE INDEX ON regie_report_products (report_id);

CREATE INDEX ON regie_report_products (product_id);

CREATE TABLE regie_report_special_records (
  id BIGINT PRIMARY KEY DEFAULT id64 (),
  report_id BIGINT NOT NULL REFERENCES regie_reports (id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  unit VARCHAR(32) NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  price_per_unit DOUBLE PRECISION,
  comment VARCHAR(255)
);

CREATE INDEX ON regie_report_special_records (report_id);

INSERT INTO
  user_roles (name)
VALUES
  ('view:regieReports'),
  ('manage:regieReports'),
  ('delete:regieReports')
ON CONFLICT DO NOTHING;
