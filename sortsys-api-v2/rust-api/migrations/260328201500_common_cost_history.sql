CREATE TABLE global_common_cost_entries (
  id BIGINT PRIMARY KEY DEFAULT id64 (),
  type TEXT NOT NULL CHECK (type IN ('fgk', 'mgk', 'ngk')),
  effective_at TIMESTAMPTZ NOT NULL,
  relative_factor DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (relative_factor >= 0),
  constant DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_by_user_id BIGINT REFERENCES users (id) ON DELETE SET NULL
);

ALTER TABLE global_common_cost_entries
ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON global_common_cost_entries (created_at);

ALTER TABLE global_common_cost_entries
ADD COLUMN modified_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON global_common_cost_entries (modified_at);

CREATE TRIGGER global_common_cost_entries_modified_at
BEFORE UPDATE ON global_common_cost_entries FOR EACH ROW
EXECUTE FUNCTION trigger_modified_at ();

CREATE UNIQUE INDEX uniq_global_common_cost_entries__type_effective_at ON global_common_cost_entries (type, effective_at);

CREATE INDEX idx_global_common_cost_entries__type_effective_at ON global_common_cost_entries (type, effective_at DESC);

WITH
  legacy AS (
    SELECT
      GREATEST(COALESCE(work_hour_overhead_factor, 1) - 1, 0) AS fgk_relative,
      GREATEST(
        COALESCE(
          (
            COALESCE(product_overhead_factor, 1) + COALESCE(special_record_overhead_factor, 1)
          ) / 2,
          1
        ) - 1,
        0
      ) AS mgk_relative
    FROM
      global_cost_settings
    WHERE
      id = 1
    LIMIT
      1
  ),
  source AS (
    SELECT
      fgk_relative,
      mgk_relative
    FROM
      legacy
    UNION ALL
    SELECT
      0,
      0
    WHERE
      NOT EXISTS (
        SELECT
          1
        FROM
          legacy
      )
  )
INSERT INTO
  global_common_cost_entries (type, effective_at, relative_factor, constant)
SELECT
  'fgk',
  '1970-01-01T00:00:00.000Z'::timestamptz,
  fgk_relative,
  0
FROM
  source
UNION ALL
SELECT
  'mgk',
  '1970-01-01T00:00:00.000Z'::timestamptz,
  mgk_relative,
  0
FROM
  source
UNION ALL
SELECT
  'ngk',
  '1970-01-01T00:00:00.000Z'::timestamptz,
  0,
  0
FROM
  source
ON CONFLICT (type, effective_at) DO NOTHING;

DROP TABLE IF EXISTS global_cost_settings;
