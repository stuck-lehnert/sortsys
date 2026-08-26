CREATE TABLE global_cost_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  product_overhead_factor DOUBLE PRECISION NOT NULL DEFAULT 1,
  work_hour_overhead_factor DOUBLE PRECISION NOT NULL DEFAULT 1,
  special_record_overhead_factor DOUBLE PRECISION NOT NULL DEFAULT 1,
  tool_overhead_factor DOUBLE PRECISION NOT NULL DEFAULT 1
);

ALTER TABLE global_cost_settings
ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON global_cost_settings (created_at);

ALTER TABLE global_cost_settings
ADD COLUMN modified_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON global_cost_settings (modified_at);

CREATE TRIGGER global_cost_settings_modified_at
BEFORE UPDATE ON global_cost_settings FOR EACH ROW
EXECUTE FUNCTION trigger_modified_at ();

INSERT INTO
  global_cost_settings (id)
VALUES
  (1)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE global_settings (key VARCHAR(255) PRIMARY KEY, name JSONB);

CREATE TABLE public_global_settings (key VARCHAR(255) PRIMARY KEY, name JSONB);
