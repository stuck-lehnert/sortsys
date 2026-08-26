CREATE FUNCTION _products_units (base_unit TEXT, other_units jsonb) RETURNS TEXT[] IMMUTABLE AS $$
  SELECT ARRAY[base_unit] || (
    SELECT array_agg(key)
    FROM jsonb_object_keys(other_units) AS key
  );
$$ LANGUAGE SQL;

CREATE TABLE products (
  id BIGINT PRIMARY KEY DEFAULT id64 (),
  custom_id INT NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  brand VARCHAR(127),
  description VARCHAR(511),
  base_unit VARCHAR(8) NOT NULL,
  other_units jsonb NOT NULL,
  _units TEXT[] GENERATED ALWAYS AS (_products_units (base_unit, other_units)) STORED
);

ALTER TABLE products
ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON products (created_at);

ALTER TABLE products
ADD COLUMN modified_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON products (modified_at);

CREATE TRIGGER products_modified_at
BEFORE UPDATE ON products FOR EACH ROW
EXECUTE FUNCTION trigger_modified_at ();

ALTER TABLE products
ADD COLUMN _search TSVECTOR GENERATED ALWAYS AS (
  create_searchable (custom_id::TEXT, name, brand, description)
) STORED;

CREATE INDEX ON products USING GIN (_search);

CREATE INDEX ON products (LOWER(name));

CREATE INDEX ON products (brand);

CREATE INDEX ON products USING GIN (other_units);

CREATE INDEX ON products USING GIN (_units);

CREATE TABLE product_categories (
  product_id BIGINT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  category VARCHAR(127) NOT NULL,
  PRIMARY KEY (product_id, category)
);

CREATE INDEX ON product_categories (product_id);

CREATE INDEX ON product_categories (category);

CREATE UNIQUE INDEX ON product_categories (product_id, LOWER(category));

CREATE TABLE product_vendors (
  id BIGINT PRIMARY KEY DEFAULT id64 (),
  name VARCHAR(127) NOT NULL,
  description VARCHAR(255)
);

ALTER TABLE product_vendors
ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON product_vendors (created_at);

ALTER TABLE product_vendors
ADD COLUMN modified_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON product_vendors (modified_at);

CREATE TRIGGER product_vendors_modified_at
BEFORE UPDATE ON product_vendors FOR EACH ROW
EXECUTE FUNCTION trigger_modified_at ();

ALTER TABLE product_vendors
ADD COLUMN _search TSVECTOR GENERATED ALWAYS AS (create_searchable (name, description)) STORED;

CREATE INDEX ON product_vendors USING GIN (_search);

CREATE TABLE product_price_records (
  id BIGINT PRIMARY KEY DEFAULT id64 (),
  product_id BIGINT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  vendor_id BIGINT REFERENCES product_vendors (id) ON DELETE SET NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  price DOUBLE PRECISION NOT NULL,
  is_real_purchase BOOLEAN NOT NULL DEFAULT FALSE,
  comment VARCHAR(255)
);

ALTER TABLE product_price_records
ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON product_price_records (created_at);

ALTER TABLE product_price_records
ADD COLUMN modified_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON product_price_records (modified_at);

CREATE TRIGGER product_price_records_modified_at
BEFORE UPDATE ON product_price_records FOR EACH ROW
EXECUTE FUNCTION trigger_modified_at ();
