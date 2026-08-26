ALTER TABLE product_delivery_records
ADD COLUMN unit VARCHAR(32);

UPDATE product_delivery_records AS pdr
SET
  unit = p.base_unit
FROM
  products AS p
WHERE
  p.id = pdr.product_id
  AND pdr.unit IS NULL;

ALTER TABLE product_delivery_records
ALTER COLUMN unit
SET NOT NULL;

ALTER TABLE daily_project_reports
ALTER COLUMN summary
DROP NOT NULL;

ALTER TABLE daily_project_report_work_hours
ADD COLUMN contract_type TEXT CHECK (
  contract_type IN ('internal', 'external', 'subcontractor')
);

UPDATE daily_project_report_work_hours AS dprwh
SET
  contract_type = COALESCE(u.contract_type, 'external')
FROM
  users AS u
WHERE
  u.id = dprwh.user_id
  AND dprwh.contract_type IS NULL;

UPDATE daily_project_report_work_hours
SET
  contract_type = 'external'
WHERE
  contract_type IS NULL;

ALTER TABLE daily_project_report_work_hours
ALTER COLUMN contract_type
SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_daily_project_report_work_hours_contract_type ON daily_project_report_work_hours (contract_type);

ALTER TABLE contacts
ALTER COLUMN first_name
DROP NOT NULL;

UPDATE contacts
SET
  first_name = NULL
WHERE
  first_name IS NOT NULL
  AND BTRIM(first_name) = '';

UPDATE contacts
SET
  last_name = NULL
WHERE
  last_name IS NOT NULL
  AND BTRIM(last_name) = '';

UPDATE contacts
SET
  first_name = 'Unbekannt'
WHERE
  first_name IS NULL
  AND last_name IS NULL;

ALTER TABLE contacts
ADD CONSTRAINT contacts_name_not_empty CHECK (
  NULLIF(BTRIM(COALESCE(first_name, '')), '') IS NOT NULL
  OR NULLIF(BTRIM(COALESCE(last_name, '')), '') IS NOT NULL
);
