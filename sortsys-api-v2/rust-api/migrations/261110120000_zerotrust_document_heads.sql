-- Public, signed document revision vectors. No file names, XML or business data.
CREATE TABLE __zerotrust_documents (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 13),
  scope TEXT NOT NULL,
  version BIGINT NOT NULL CHECK (version > 0),
  hash TEXT NOT NULL,
  head JSONB NOT NULL CHECK (jsonb_typeof(head)='object')
);
CREATE TABLE __zerotrust_document_history (
  id TEXT NOT NULL REFERENCES __zerotrust_documents(id),
  version BIGINT NOT NULL CHECK (version > 0),
  hash TEXT NOT NULL,
  head JSONB NOT NULL CHECK (jsonb_typeof(head)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(id,version),
  UNIQUE(id,hash)
);
