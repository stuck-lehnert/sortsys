-- Customer-facing product designation for time-and-material reports.
ALTER TABLE products ADD COLUMN regie_report_name VARCHAR(255);

-- Rebuild the stored search vector (including existing products) and its index.
ALTER TABLE products DROP COLUMN _search;
ALTER TABLE products ADD COLUMN _search TSVECTOR GENERATED ALWAYS AS (
  create_searchable(custom_id::TEXT, name, brand, description, regie_report_name)
) STORED;
CREATE INDEX products_search_idx ON products USING GIN (_search);
