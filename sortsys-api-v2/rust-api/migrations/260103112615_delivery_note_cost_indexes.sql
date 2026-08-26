CREATE INDEX ON product_price_records (product_id, timestamp DESC);

CREATE INDEX ON product_price_records (product_id, timestamp DESC) INCLUDE (vendor_id, price, is_real_purchase, comment);

CREATE INDEX ON product_price_records (timestamp DESC) INCLUDE (
  product_id,
  vendor_id,
  price,
  is_real_purchase,
  comment
);

CREATE INDEX ON product_delivery_notes (effective_timestamp DESC, id DESC);

CREATE INDEX ON product_delivery_notes (project_id, effective_timestamp DESC, id DESC);
