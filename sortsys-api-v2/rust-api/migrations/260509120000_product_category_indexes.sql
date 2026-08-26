CREATE INDEX IF NOT EXISTS idx_product_categories_lower_category ON product_categories (LOWER(category), category);
