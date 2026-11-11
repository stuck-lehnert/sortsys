-- Schema only: no tenant rows or authentication material leave PostgreSQL.
WITH tables AS (
  SELECT c.oid, c.relname AS name
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND left(c.relname, 2) <> '__'
    AND c.relname NOT LIKE 'zerotrust\_%' ESCAPE '\'
    AND c.relname NOT IN ('user_sessions', 'user_passkeys', 'user_roles', 'user_role_assignments', 'development_seed_manifests')
), columns AS (
  SELECT t.name AS table_name, a.attnum,
    jsonb_build_object(
      'name', a.attname, 'type', ty.typname, 'sqlType', format_type(a.atttypid, a.atttypmod),
      'nullable', NOT a.attnotnull,
      'maxLength', ic.character_maximum_length,
      'precision', ic.numeric_precision, 'scale', ic.numeric_scale,
      'default', pg_get_expr(d.adbin, d.adrelid)
    ) AS definition
  FROM tables t JOIN pg_attribute a ON a.attrelid = t.oid
  JOIN pg_type ty ON ty.oid = a.atttypid
  JOIN information_schema.columns ic ON ic.table_schema = 'public' AND ic.table_name = t.name AND ic.column_name = a.attname
  LEFT JOIN pg_attrdef d ON d.adrelid = t.oid AND d.adnum = a.attnum
  WHERE a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
    AND NOT (t.name = 'users' AND a.attname IN ('password', 'totp_uri'))
), constraints AS (
  SELECT t.name AS table_name, con.conname AS name,
    jsonb_build_object(
      'kind', con.contype, 'expression', pg_get_constraintdef(con.oid),
      'columns', COALESCE((SELECT jsonb_agg(a.attname ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.num), '[]'::jsonb),
      'referencedTable', CASE WHEN con.contype='f' THEN con.confrelid::regclass::text ELSE NULL END,
      'referencedColumns', COALESCE((SELECT jsonb_agg(a.attname ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=con.confrelid AND a.attnum=k.num), '[]'::jsonb)
    ) AS definition
  FROM tables t JOIN pg_constraint con ON con.conrelid=t.oid
  WHERE con.contype IN ('p','u','c','f')
    AND NOT EXISTS (SELECT 1 FROM unnest(con.conkey) k(num) JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.num
      WHERE a.attgenerated <> '' OR (t.name='users' AND a.attname IN ('password', 'totp_uri')))
), unique_indexes AS (
  SELECT t.name AS table_name, idx.relname AS name,
    jsonb_build_object(
      'name', idx.relname,
      'expressions', (SELECT jsonb_agg(pg_get_indexdef(i.indexrelid,k,true) ORDER BY k) FROM generate_series(1,i.indnkeyatts) k),
      'predicate', pg_get_expr(i.indpred,i.indrelid),
      'nullsNotDistinct', i.indnullsnotdistinct
    ) AS definition
  FROM tables t JOIN pg_index i ON i.indrelid=t.oid JOIN pg_class idx ON idx.oid=i.indexrelid
  WHERE i.indisunique AND i.indisvalid
    AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid=i.indexrelid AND con.contype IN ('p','u','x'))
    AND NOT EXISTS (SELECT 1 FROM unnest(i.indkey) k(num) JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.num
      WHERE a.attgenerated <> '' OR (t.name='users' AND a.attname IN ('password', 'totp_uri')))
)
SELECT jsonb_build_object(
  'tables', (SELECT jsonb_agg(jsonb_build_object(
    'name', t.name,
    'columns', (SELECT jsonb_agg(c.definition ORDER BY c.attnum) FROM columns c WHERE c.table_name=t.name),
    'constraints', COALESCE((SELECT jsonb_agg(c.definition ORDER BY c.name) FROM constraints c WHERE c.table_name=t.name), '[]'::jsonb),
    'uniqueIndexes', COALESCE((SELECT jsonb_agg(i.definition ORDER BY i.name) FROM unique_indexes i WHERE i.table_name=t.name), '[]'::jsonb)
  ) ORDER BY t.name) FROM tables t),
  'enums', COALESCE((SELECT jsonb_object_agg(e.name,e.values) FROM (
    SELECT t.typname AS name, jsonb_agg(e.enumlabel ORDER BY e.enumsortorder) AS values
    FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='public' GROUP BY t.typname
  ) e), '{}'::jsonb)
);
