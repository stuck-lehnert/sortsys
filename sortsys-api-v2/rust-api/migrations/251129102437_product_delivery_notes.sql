CREATE TABLE product_delivery_notes (
  id BIGINT PRIMARY KEY DEFAULT id64 (),
  auto_id BIGSERIAL NOT NULL UNIQUE,
  project_id BIGINT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  comment VARCHAR(511),
  created_by_user_id BIGINT REFERENCES users (id) ON DELETE SET NULL,
  effective_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  _search TSVECTOR GENERATED ALWAYS AS (create_searchable (auto_id::text, comment)) STORED
);

ALTER TABLE product_delivery_notes
ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX ON product_delivery_notes (created_at);

CREATE INDEX ON product_delivery_notes (auto_id);

CREATE INDEX ON product_delivery_notes (project_id);

CREATE INDEX ON product_delivery_notes (created_by_user_id);

CREATE INDEX ON product_delivery_notes (created_at);

CREATE TABLE product_delivery_records (
  id BIGINT PRIMARY KEY DEFAULT id64 (),
  note_id BIGINT NOT NULL REFERENCES product_delivery_notes (id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  quantity DOUBLE PRECISION NOT NULL,
  comment VARCHAR(255)
);

CREATE INDEX ON product_delivery_records (note_id);

CREATE INDEX ON product_delivery_records (product_id);

CREATE INDEX ON product_delivery_records (note_id, product_id);

CREATE INDEX ON product_delivery_records (quantity);

CREATE TABLE product_delivery_special_records (
  id BIGINT PRIMARY KEY DEFAULT id64 (),
  note_id BIGINT NOT NULL REFERENCES product_delivery_notes (id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  unit VARCHAR(32) NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  price_per_unit DOUBLE PRECISION,
  comment VARCHAR(255)
);

CREATE INDEX ON product_delivery_special_records (note_id);

CREATE INDEX ON product_delivery_special_records (name);
