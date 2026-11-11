CREATE TABLE __zerotrust_stock_references (
  object_id TEXT PRIMARY KEY REFERENCES __zerotrust_objects(id),
  kind TEXT NOT NULL CHECK (kind IN ('product','vendor','price')),
  product_object_id TEXT REFERENCES __zerotrust_stock_references(object_id) DEFERRABLE INITIALLY DEFERRED,
  vendor_object_id TEXT REFERENCES __zerotrust_stock_references(object_id) DEFERRABLE INITIALLY DEFERRED,
  definition JSONB NOT NULL CHECK (jsonb_typeof(definition)='object'),
  CHECK ((kind='price' AND product_object_id IS NOT NULL) OR (kind<>'price' AND product_object_id IS NULL AND vendor_object_id IS NULL))
);
CREATE INDEX ON __zerotrust_stock_references(product_object_id) WHERE product_object_id IS NOT NULL;
CREATE INDEX ON __zerotrust_stock_references(vendor_object_id) WHERE vendor_object_id IS NOT NULL;

CREATE TABLE __zerotrust_stock_deletions (
  object_id TEXT PRIMARY KEY REFERENCES __zerotrust_objects(id),
  root_object_id TEXT NOT NULL REFERENCES __zerotrust_objects(id),
  definition JSONB NOT NULL CHECK (jsonb_typeof(definition)='object'),
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
