CREATE INDEX IF NOT EXISTS idx_project_financial_entries_cost_overview ON project_financial_entries (project_id) INCLUDE (type, amount);

CREATE INDEX IF NOT EXISTS idx_daily_project_reports_cost_overview ON daily_project_reports (project_id) INCLUDE (id, DAY);
