CREATE INDEX IF NOT EXISTS idx_projects_activity_occurred_at ON projects ((GREATEST(created_at, modified_at)) DESC) INCLUDE (id, title, created_at, modified_at);

CREATE INDEX IF NOT EXISTS idx_tools_activity_occurred_at ON tools ((GREATEST(created_at, modified_at)) DESC) INCLUDE (
  id,
  custom_id,
  brand,
  category,
  label,
  created_at,
  modified_at
);

CREATE INDEX IF NOT EXISTS idx_users_activity_occurred_at ON users ((GREATEST(created_at, modified_at)) DESC) INCLUDE (
  id,
  first_name,
  last_name,
  username,
  created_at,
  modified_at
)
WHERE
  archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_customers_activity_occurred_at ON customers ((GREATEST(created_at, modified_at)) DESC) INCLUDE (id, salutation, name, created_at, modified_at);

CREATE INDEX IF NOT EXISTS idx_contacts_activity_occurred_at ON contacts ((GREATEST(created_at, modified_at)) DESC) INCLUDE (
  id,
  salutation,
  first_name,
  last_name,
  created_at,
  modified_at
);

CREATE INDEX IF NOT EXISTS idx_products_activity_occurred_at ON products ((GREATEST(created_at, modified_at)) DESC) INCLUDE (
  id,
  custom_id,
  brand,
  name,
  created_at,
  modified_at
);

CREATE INDEX IF NOT EXISTS idx_product_vendors_activity_occurred_at ON product_vendors ((GREATEST(created_at, modified_at)) DESC) INCLUDE (id, name, created_at, modified_at);

CREATE INDEX IF NOT EXISTS idx_product_delivery_notes_activity_created_at ON product_delivery_notes (created_at DESC) INCLUDE (id, project_id, auto_id);

CREATE INDEX IF NOT EXISTS idx_regie_reports_activity_created_at ON regie_reports (created_at DESC) INCLUDE (id, project_id, DAY);

CREATE INDEX IF NOT EXISTS idx_daily_project_reports_activity_created_at ON daily_project_reports (created_at DESC) INCLUDE (id, project_id, DAY);
