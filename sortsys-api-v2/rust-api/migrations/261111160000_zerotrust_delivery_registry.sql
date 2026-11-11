-- Public technical note identifiers/numbers; never quantities, text or prices.
CREATE TABLE __zerotrust_delivery_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  initialized BOOLEAN NOT NULL DEFAULT FALSE,
  last_number BIGINT NOT NULL DEFAULT 0 CHECK (last_number >= 0)
);
INSERT INTO __zerotrust_delivery_state(singleton) VALUES(TRUE);
CREATE TABLE __zerotrust_delivery_allocations (
  id BIGINT PRIMARY KEY DEFAULT id64(),
  project_id BIGINT NOT NULL,
  number BIGINT NOT NULL UNIQUE CHECK (number > 0),
  author TEXT,
  request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((author IS NULL) = (request_id IS NULL)),
  UNIQUE(author,request_id)
);
