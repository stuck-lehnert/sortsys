CREATE TABLE IF NOT EXISTS __entity_changes (
  id BIGSERIAL PRIMARY KEY,
  entity_table TEXT NOT NULL,
  entity_key JSONB NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created', 'updated', 'deleted')),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  actor_tenant TEXT,
  actor_user_id BIGINT,
  actor_kind TEXT NOT NULL,
  actor_name TEXT,
  changed_columns TEXT[] NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_master_entity_history
ON __entity_changes (entity_table, occurred_at DESC, id DESC);

CREATE OR REPLACE FUNCTION trigger_master_entity_change() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  row_data JSONB;
  previous_data JSONB;
  identity JSONB;
  changed TEXT[];
BEGIN
  row_data := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  previous_data := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END;
  SELECT jsonb_object_agg(key, value) INTO identity
  FROM jsonb_each(row_data) WHERE key = ANY(string_to_array(TG_ARGV[0], ','));
  SELECT array_agg(key ORDER BY key) INTO changed
  FROM jsonb_each(row_data || COALESCE(previous_data, '{}'::jsonb))
  WHERE key <> 'updated_at'
    AND (TG_OP <> 'UPDATE' OR row_data -> key IS DISTINCT FROM previous_data -> key);
  IF TG_OP = 'UPDATE' AND changed IS NULL THEN RETURN NULL; END IF;

  -- Configuration contains provider keys, database passwords and admin hashes.
  -- Retain identity and changed field names, never copies of those values.
  INSERT INTO __entity_changes (
    entity_table, entity_key, action, actor_tenant,
    actor_user_id, actor_kind, actor_name, changed_columns
  ) VALUES (
    TG_TABLE_NAME, identity,
    CASE TG_OP WHEN 'INSERT' THEN 'created' WHEN 'UPDATE' THEN 'updated' ELSE 'deleted' END,
    NULLIF(current_setting('sortsys.actor_tenant', true), ''),
    NULLIF(current_setting('sortsys.actor_id', true), '')::bigint,
    COALESCE(NULLIF(current_setting('sortsys.actor_kind', true), ''), 'system'),
    NULLIF(current_setting('sortsys.actor_name', true), ''), COALESCE(changed, '{}')
  );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION prevent_master_history_changes() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Entity history is append-only';
END;
$$;

DO $$
DECLARE
  entity RECORD;
BEGIN
  FOR entity IN
    SELECT c.relname AS table_name, array_agg(a.attname::text ORDER BY k.ordinality) AS keys
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary
    CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ordinality)
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
    WHERE n.nspname = 'public' AND c.relname IN (
      '__tenants', '__postgres_hosts', '__postgres_databases', '__postgres_database_backups',
      '__llm_settings', '__llm_scan_settings', '__llm_provider_accounts', '__llm_use_case_settings'
    )
    GROUP BY c.relname, c.oid
    HAVING NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = c.oid AND tgname = 'entity_change')
  LOOP
    EXECUTE format('CREATE TRIGGER entity_change AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION trigger_master_entity_change(%L)',
      entity.table_name, array_to_string(entity.keys, ','));
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = '__entity_changes'::regclass AND tgname = 'entity_history_immutable') THEN
    CREATE TRIGGER entity_history_immutable BEFORE UPDATE OR DELETE ON __entity_changes
    FOR EACH ROW EXECUTE FUNCTION prevent_master_history_changes();
  END IF;
END;
$$;
