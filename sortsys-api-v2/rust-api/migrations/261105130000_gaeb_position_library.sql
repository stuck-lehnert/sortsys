-- Search metadata is tenant-local; native files remain authoritative.
CREATE TABLE gaeb_position_sources (
  kind TEXT NOT NULL CHECK (kind IN ('commercial','file')),
  source_id BIGINT NOT NULL,
  object_key TEXT NOT NULL,
  PRIMARY KEY (kind, source_id)
);
CREATE TABLE gaeb_position_library (
  kind TEXT NOT NULL,
  source_id BIGINT NOT NULL,
  item_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  short_text TEXT NOT NULL,
  description TEXT NOT NULL,
  unit TEXT NOT NULL,
  PRIMARY KEY (kind, source_id, item_id),
  FOREIGN KEY (kind, source_id) REFERENCES gaeb_position_sources(kind, source_id) ON DELETE CASCADE
);
CREATE INDEX gaeb_position_library_text ON gaeb_position_library USING GIN (to_tsvector('simple', short_text || ' ' || description));
CREATE INDEX gaeb_position_library_fingerprint ON gaeb_position_library(fingerprint);
