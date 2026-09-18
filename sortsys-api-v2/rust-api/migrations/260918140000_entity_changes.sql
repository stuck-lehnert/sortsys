CREATE TABLE IF NOT EXISTS entity_changes (
  id BIGINT PRIMARY KEY DEFAULT id64(),
  entity_table TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_key JSONB NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created', 'updated', 'deleted', 'completed', 'resumed')),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  entity_created_at TIMESTAMPTZ,
  actor_user_id BIGINT,
  actor_kind TEXT NOT NULL DEFAULT 'system',
  actor_name TEXT,
  changed_columns TEXT[] NOT NULL DEFAULT '{}',
  resource_type TEXT,
  resource_id BIGINT,
  context_id BIGINT,
  context_title TEXT,
  context_date DATE,
  title TEXT NOT NULL,
  description TEXT,
  is_imported BOOLEAN NOT NULL DEFAULT FALSE,
  resource_title TEXT,
  subject_user_id BIGINT,
  participant_user_ids BIGINT[] NOT NULL DEFAULT '{}'
);

-- Earlier development builds may already contain the provisional history table.
-- Upgrade it in place without changing or re-importing existing history.
ALTER TABLE entity_changes
ADD COLUMN IF NOT EXISTS resource_title TEXT,
ADD COLUMN IF NOT EXISTS subject_user_id BIGINT,
ADD COLUMN IF NOT EXISTS participant_user_ids BIGINT[] NOT NULL DEFAULT '{}';

ALTER TABLE entity_changes
DROP CONSTRAINT IF EXISTS entity_changes_action_check;

ALTER TABLE entity_changes
ADD CONSTRAINT entity_changes_action_check
CHECK (action IN ('created', 'updated', 'deleted', 'completed', 'resumed'));

-- No foreign keys to the audited rows or actors: deletion must retain history.
CREATE INDEX IF NOT EXISTS idx_entity_changes_resource ON entity_changes (resource_type, resource_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_entity_changes_context ON entity_changes (context_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_entity_changes_time ON entity_changes (occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_entity_changes_entity ON entity_changes (entity_table, entity_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION entity_activity_resource_title(kind TEXT, resource BIGINT)
RETURNS TEXT LANGUAGE plpgsql STABLE AS $$
DECLARE
  label TEXT;
BEGIN
  CASE kind
    WHEN 'project' THEN
      SELECT title INTO label FROM projects WHERE id = resource;
    WHEN 'tool' THEN
      SELECT NULLIF(concat_ws(' ', brand, category, tools.label), '')
      INTO label FROM tools WHERE id = resource;
    WHEN 'user' THEN
      SELECT NULLIF(concat_ws(' ', first_name, last_name), '')
      INTO label FROM users WHERE id = resource;
    WHEN 'customer' THEN
      SELECT name INTO label FROM customers WHERE id = resource;
    WHEN 'contact' THEN
      SELECT NULLIF(concat_ws(' ', first_name, last_name), '')
      INTO label FROM contacts WHERE id = resource;
    WHEN 'product' THEN
      SELECT name INTO label FROM products WHERE id = resource;
    WHEN 'productVendor' THEN
      SELECT name INTO label FROM product_vendors WHERE id = resource;
    WHEN 'deliveryNote' THEN
      SELECT 'Lieferschein #' || auto_id INTO label
      FROM product_delivery_notes WHERE id = resource;
    WHEN 'regieReport' THEN
      SELECT 'Regiebericht ' || to_char(day, 'DD.MM.YYYY') INTO label
      FROM regie_reports WHERE id = resource;
    WHEN 'dailyProjectReport' THEN
      SELECT 'Bautagesbericht ' || to_char(day, 'DD.MM.YYYY') INTO label
      FROM daily_project_reports WHERE id = resource;
    ELSE NULL;
  END CASE;
  RETURN label;
END;
$$;

CREATE OR REPLACE FUNCTION append_entity_change(
  table_name TEXT,
  row_data JSONB,
  previous_data JSONB,
  operation TEXT,
  key_columns TEXT[],
  imported BOOLEAN DEFAULT FALSE
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  identity JSONB;
  changed TEXT[];
  kind TEXT;
  resource BIGINT;
  project BIGINT;
  project_name TEXT;
  report_day DATE;
  label TEXT;
  related JSONB;
  owner_title TEXT;
  subject BIGINT;
  participants BIGINT[] := '{}';
BEGIN
  SELECT jsonb_object_agg(key, value) INTO identity
  FROM jsonb_each(row_data) WHERE key = ANY(key_columns);

  SELECT array_agg(key ORDER BY key) INTO changed
  FROM jsonb_each(row_data || COALESCE(previous_data, '{}'::jsonb))
  WHERE key NOT LIKE '\_%' ESCAPE '\'
    AND key NOT IN ('modified_at', 'updated_at')
    AND (operation <> 'updated' OR row_data -> key IS DISTINCT FROM previous_data -> key);

  -- Timestamp/search-vector-only updates are not user-visible changes.
  IF operation = 'updated' AND changed IS NULL THEN RETURN; END IF;

  -- User deletion archives the row so references remain valid.
  IF table_name = 'users' AND operation = 'updated'
    AND previous_data ->> 'archived_at' IS NULL AND row_data ->> 'archived_at' IS NOT NULL THEN
    operation := 'deleted';
  END IF;

  -- Keep lifecycle transitions distinct while retaining the fields they changed.
  IF table_name = 'projects' AND operation = 'updated' AND 'finished_at' = ANY(changed) THEN
    operation := CASE WHEN row_data ->> 'finished_at' IS NULL THEN 'resumed' ELSE 'completed' END;
  END IF;

  kind := CASE table_name
    WHEN 'projects' THEN 'project'
    WHEN 'tools' THEN 'tool'
    WHEN 'users' THEN 'user'
    WHEN 'customers' THEN 'customer'
    WHEN 'contacts' THEN 'contact'
    WHEN 'products' THEN 'product'
    WHEN 'product_vendors' THEN 'productVendor'
    WHEN 'product_delivery_notes' THEN 'deliveryNote'
    WHEN 'regie_reports' THEN 'regieReport'
    WHEN 'daily_project_reports' THEN 'dailyProjectReport'
    ELSE NULL
  END;
  resource := CASE WHEN kind IS NOT NULL THEN (row_data ->> 'id')::bigint END;
  project := (row_data ->> 'project_id')::bigint;
  IF table_name IN ('regie_reports', 'daily_project_reports', 'regie_report_work_hours') THEN
    report_day := (row_data ->> 'day')::date;
  END IF;

  IF kind IS NULL THEN
    IF table_name LIKE 'regie_report_%' OR table_name = 'daily_project_report_work_hours'
       OR table_name = 'daily_project_report_files' THEN
      kind := CASE WHEN table_name LIKE 'regie_report_%' THEN 'regieReport' ELSE 'dailyProjectReport' END;
      resource := (row_data ->> 'report_id')::bigint;
      IF kind = 'regieReport' THEN SELECT to_jsonb(r) INTO related FROM regie_reports r WHERE id = resource;
      ELSE SELECT to_jsonb(r) INTO related FROM daily_project_reports r WHERE id = resource; END IF;
      project := (related ->> 'project_id')::bigint;
      report_day := (related ->> 'day')::date;
    ELSIF table_name IN ('product_delivery_records', 'product_delivery_special_records') THEN
      kind := 'deliveryNote';
      resource := (row_data ->> 'note_id')::bigint;
      SELECT to_jsonb(n) INTO related FROM product_delivery_notes n WHERE id = resource;
      project := (related ->> 'project_id')::bigint;
    ELSIF table_name IN ('product_categories', 'product_price_records') THEN
      kind := 'product'; resource := (row_data ->> 'product_id')::bigint;
    ELSIF table_name IN ('tool_trackings', 'tool_inventories', 'tool_tracking_transfer_requests') THEN
      kind := 'tool'; resource := (row_data ->> 'tool_id')::bigint;
      IF resource IS NULL THEN SELECT tool_id INTO resource FROM tool_trackings WHERE id = (row_data ->> 'tool_tracking_id')::bigint; END IF;
    ELSIF table_name IN ('user_vacations', 'user_role_assignments', 'user_passkeys') THEN
      kind := 'user'; resource := (row_data ->> 'user_id')::bigint;
    ELSIF table_name = 'customer_contacts' THEN
      kind := 'customer'; resource := (row_data ->> 'customer_id')::bigint;
    ELSIF table_name = 'resource_notes' THEN
      IF project IS NOT NULL THEN kind := 'project'; resource := project;
      ELSIF row_data ? 'customer_id' AND row_data ->> 'customer_id' IS NOT NULL THEN kind := 'customer'; resource := (row_data ->> 'customer_id')::bigint;
      ELSIF row_data ->> 'tool_id' IS NOT NULL THEN kind := 'tool'; resource := (row_data ->> 'tool_id')::bigint;
      ELSE kind := 'contact'; resource := (row_data ->> 'contact_id')::bigint; END IF;
    ELSIF project IS NOT NULL THEN
      kind := 'project'; resource := project;
    END IF;
  END IF;

  IF project IS NOT NULL THEN SELECT title INTO project_name FROM projects WHERE id = project; END IF;
  label := COALESCE(row_data ->> 'title', row_data ->> 'name', row_data ->> 'file_name',
    NULLIF(concat_ws(' ', row_data ->> 'first_name', row_data ->> 'last_name'), ''),
    NULLIF(concat_ws(' ', row_data ->> 'brand', row_data ->> 'category', row_data ->> 'label'), ''),
    related ->> 'summary', project_name, table_name);

  IF table_name = 'product_delivery_notes' THEN label := 'Lieferschein #' || (row_data ->> 'auto_id'); END IF;
  IF table_name IN ('regie_reports', 'daily_project_reports') THEN
    label := CASE WHEN table_name = 'regie_reports' THEN 'Regiebericht ' ELSE 'Bautagesbericht ' END || to_char(report_day, 'DD.MM.YYYY');
  END IF;

  owner_title := entity_activity_resource_title(kind, resource);
  IF owner_title IS NULL AND kind IS NOT NULL THEN
    owner_title := NULLIF(label, table_name);
  END IF;
  IF kind IS NOT NULL AND table_name NOT IN (
    'projects', 'tools', 'users', 'customers', 'contacts', 'products',
    'product_vendors', 'product_delivery_notes', 'regie_reports', 'daily_project_reports',
    'project_files', 'project_file_folders'
  ) THEN
    label := COALESCE(owner_title, table_name);
  END IF;
  IF label = table_name THEN label := COALESCE(owner_title, table_name); END IF;
  IF kind IS NULL THEN label := table_name; END IF;

  subject := COALESCE((row_data ->> 'user_id')::bigint,
    (row_data ->> 'responsible_user_id')::bigint,
    CASE WHEN kind = 'user' THEN resource END);

  IF table_name = 'tool_trackings' THEN
    participants := array_remove(ARRAY[subject], NULL);
  ELSIF table_name = 'tool_tracking_transfer_requests' THEN
    SELECT responsible_user_id INTO subject
    FROM tool_trackings WHERE id = (row_data ->> 'tool_tracking_id')::bigint;
    participants := array_remove(ARRAY[subject,
      (row_data ->> 'created_by_user_id')::bigint,
      (row_data ->> 'transfer_to_user_id')::bigint], NULL);
  END IF;

  INSERT INTO entity_changes (
    entity_table, entity_id, entity_key, action, occurred_at, entity_created_at,
    actor_user_id, actor_kind, actor_name, changed_columns,
    resource_type, resource_id, context_id, context_title, context_date,
    title, description, is_imported, resource_title, subject_user_id, participant_user_ids
  ) VALUES (
    table_name, CASE WHEN cardinality(key_columns) = 1 THEN row_data ->> key_columns[1] ELSE identity::text END,
    identity, operation,
    CASE WHEN imported THEN COALESCE((row_data ->> 'created_at')::timestamptz, clock_timestamp()) ELSE clock_timestamp() END,
    (row_data ->> 'created_at')::timestamptz,
    CASE WHEN imported THEN (row_data ->> 'created_by_user_id')::bigint ELSE NULLIF(current_setting('sortsys.actor_id', true), '')::bigint END,
    CASE WHEN imported THEN 'legacy' ELSE COALESCE(NULLIF(current_setting('sortsys.actor_kind', true), ''), 'system') END,
    CASE WHEN imported THEN NULL ELSE NULLIF(current_setting('sortsys.actor_name', true), '') END, COALESCE(changed, '{}'),
    kind, resource, project, project_name, report_day,
    label, NULL, imported, owner_title, subject, participants
  );
END;
$$;

CREATE OR REPLACE FUNCTION prevent_entity_history_changes() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Entity history is append-only';
END;
$$;

DROP TRIGGER IF EXISTS entity_history_immutable ON entity_changes;

CREATE TRIGGER entity_history_immutable
BEFORE UPDATE OR DELETE ON entity_changes FOR EACH ROW
EXECUTE FUNCTION prevent_entity_history_changes();

CREATE OR REPLACE FUNCTION trigger_entity_change() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM append_entity_change(
    TG_TABLE_NAME,
    CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END,
    CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END,
    CASE TG_OP WHEN 'INSERT' THEN 'created' WHEN 'UPDATE' THEN 'updated' ELSE 'deleted' END,
    string_to_array(TG_ARGV[0], ',')
  );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION install_entity_change_triggers() RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  entity RECORD;
BEGIN
  -- Include every primary-keyed entity, including composite-key associations.
  -- Operational request/session/cache data is not an entity activity feed.
  FOR entity IN
    SELECT c.relname AS table_name, array_agg(a.attname::text ORDER BY k.ordinality) AS keys
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary
    CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ordinality)
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND c.relname NOT LIKE '\_\_%' ESCAPE '\'
      AND c.relname NOT IN ('entity_changes', 'resource_action_log_entries', 'user_sessions',
        'user_visit_history', 'user_action_history', 'client_error_reports')
      AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = c.oid AND tgname = 'entity_change')
    GROUP BY c.relname
  LOOP
    EXECUTE format('CREATE TRIGGER entity_change AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION trigger_entity_change(%L)',
      entity.table_name, array_to_string(entity.keys, ','));

    -- Import known creation dates only. Earlier edits/deletions cannot be reconstructed.
    IF entity.table_name IN ('projects', 'tools', 'users', 'customers', 'contacts', 'products',
      'product_vendors', 'product_delivery_notes', 'regie_reports', 'daily_project_reports') THEN
      EXECUTE format('SELECT append_entity_change(%L, to_jsonb(e), NULL, ''created'', %L::text[], true) FROM %I e',
        entity.table_name, entity.keys, entity.table_name);
    END IF;
  END LOOP;
END;
$$;

SELECT install_entity_change_triggers();
