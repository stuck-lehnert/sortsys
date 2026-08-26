ALTER TABLE projects
ADD COLUMN order_received_at TIMESTAMPTZ;

CREATE INDEX ON projects (order_received_at);
