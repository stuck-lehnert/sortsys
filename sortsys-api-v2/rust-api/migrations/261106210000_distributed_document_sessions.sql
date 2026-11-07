-- Ephemeral CRDT sessions are shared by all API replicas. Native XML remains
-- the durable business document; these tables contain deltas and expiring peers.
CREATE TABLE __xml_live_rooms (
  room TEXT PRIMARY KEY,
  epoch BIGINT NOT NULL DEFAULT 1,
  seq BIGINT NOT NULL DEFAULT 0,
  checkpoint BIGINT NOT NULL DEFAULT 0,
  snapshot BYTEA,
  log_bytes BIGINT NOT NULL DEFAULT 0,
  touched_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE __xml_live_updates (
  room TEXT NOT NULL REFERENCES __xml_live_rooms(room) ON DELETE CASCADE,
  seq BIGINT NOT NULL,
  data BYTEA NOT NULL CHECK(octet_length(data) <= 33554432),
  PRIMARY KEY(room, seq)
);
CREATE TABLE __xml_live_fields (
  room TEXT NOT NULL REFERENCES __xml_live_rooms(room) ON DELETE CASCADE,
  key TEXT NOT NULL,
  PRIMARY KEY(room, key)
);
CREATE TABLE __xml_live_peers (
  id TEXT PRIMARY KEY,
  room TEXT NOT NULL REFERENCES __xml_live_rooms(room) ON DELETE CASCADE,
  instance TEXT NOT NULL,
  epoch BIGINT NOT NULL,
  data JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX ON __xml_live_peers(room, expires_at);
CREATE INDEX ON __xml_live_peers(instance);
CREATE INDEX ON __xml_live_peers(expires_at);

CREATE FUNCTION xml_live_peer_notice() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify('sortsys_xml_live', json_build_object('room', OLD.room, 'kind', 'leave', 'id', OLD.id, 'epoch', OLD.epoch)::text);
  ELSIF TG_OP = 'INSERT' OR NEW.data IS DISTINCT FROM OLD.data THEN
    PERFORM pg_notify('sortsys_xml_live', json_build_object('room', NEW.room, 'kind', 'peer', 'peer', NEW.data, 'epoch', NEW.epoch)::text);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER xml_live_peer AFTER INSERT OR UPDATE OR DELETE ON __xml_live_peers
FOR EACH ROW EXECUTE FUNCTION xml_live_peer_notice();

-- Trigger notifications commit atomically with business writes, including writes
-- on another replica. Never publish an S3 key, user data or XML in this channel.
CREATE FUNCTION xml_live_document_notice() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE room_key TEXT; revision BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'project_files' THEN
    room_key := 'project:' || NEW.project_id || ':' || NEW.id;
    revision := NEW.office_version;
  ELSIF TG_TABLE_NAME = 'commercial_documents' THEN
    room_key := 'commercial:' || NEW.case_id || ':' || NEW.id;
    revision := NEW.version;
  ELSE
    room_key := 'commercial:' || NEW.case_id || ':0';
  END IF;
  PERFORM pg_notify('sortsys_xml_live', json_build_object('room', room_key, 'kind', 'changed', 'version', revision)::text);
  RETURN NULL;
END $$;
CREATE TRIGGER xml_live_project_file AFTER UPDATE OF office_version ON project_files
FOR EACH ROW EXECUTE FUNCTION xml_live_document_notice();
CREATE TRIGGER xml_live_commercial_document AFTER INSERT OR UPDATE ON commercial_documents
FOR EACH ROW EXECUTE FUNCTION xml_live_document_notice();
CREATE TRIGGER xml_live_case_event AFTER INSERT ON commercial_case_events
FOR EACH ROW EXECUTE FUNCTION xml_live_document_notice();
CREATE FUNCTION xml_live_case_notice() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('sortsys_xml_live', json_build_object('room', 'commercial:' || NEW.id || ':0', 'kind', 'changed')::text);
  RETURN NULL;
END $$;
CREATE TRIGGER xml_live_case AFTER UPDATE ON commercial_cases
FOR EACH ROW EXECUTE FUNCTION xml_live_case_notice();
