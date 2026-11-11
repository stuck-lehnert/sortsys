-- Certified public creation capabilities and immutable public area origins.
CREATE TABLE __zerotrust_creation_capabilities (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  generation BIGINT NOT NULL CHECK (generation > 0),
  capability JSONB NOT NULL CHECK (jsonb_typeof(capability)='object')
);
CREATE TABLE __zerotrust_created_areas (
  domain_id TEXT PRIMARY KEY REFERENCES __zerotrust_domains(id),
  root_generation BIGINT NOT NULL CHECK (root_generation > 0),
  creator TEXT NOT NULL,
  readers TEXT[] NOT NULL,
  origin JSONB NOT NULL CHECK (jsonb_typeof(origin)='object')
);
CREATE INDEX ON __zerotrust_created_areas(root_generation,creator);
CREATE INDEX ON __zerotrust_created_areas USING GIN(readers);
