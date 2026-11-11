-- Immutable encrypted file blocks. Publication of a file's encrypted manifest
-- happens separately, after all referenced blocks have become durable.
CREATE TABLE __zerotrust_file_chunks (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL REFERENCES __zerotrust_domains(id),
  envelope JSONB NOT NULL CHECK (jsonb_typeof(envelope)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON __zerotrust_file_chunks(domain_id);
