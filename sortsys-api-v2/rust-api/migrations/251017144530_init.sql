CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION id64 () RETURNS bigint AS $$
DECLARE
    b bytea := gen_random_bytes(8);
    r bigint := 0;
BEGIN
    -- Build 64-bit integer from 8 bytes
    r :=
          ((get_byte(b,0)::bigint  & 0x7F) << 56)
        | (get_byte(b,1)::bigint << 48)
        | (get_byte(b,2)::bigint << 40)
        | (get_byte(b,3)::bigint << 32)
        | (get_byte(b,4)::bigint << 24)
        | (get_byte(b,5)::bigint << 16)
        | (get_byte(b,6)::bigint <<  8)
        |  get_byte(b,7)::bigint;

    -- Force positive (mask off sign bit)
    RETURN r;
END;
$$ LANGUAGE PLPGSQL VOLATILE;

-- CREATE OR REPLACE FUNCTION ulid64() RETURNS bigint AS $$
-- DECLARE
--   -- current timestamp in milliseconds since 1970-01-01 UTC
--   ts_ms       bigint := FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000);
--   -- mask to 42 bits: (1 << 42) - 1
--   ts_mask     bigint := (1::bigint << 42) - 1;
--   -- 22-bit random: [0 .. 2^22-1]
--   rand_bits   bigint := FLOOR(random() * (1 << 22));
-- BEGIN
--   -- pack: (lower-42-bits-of-ts_ms) << 22  OR  rand_bits
--   RETURN ((ts_ms & ts_mask) << 22) | rand_bits;
-- END;
-- $$ LANGUAGE PLPGSQL VOLATILE;
CREATE OR REPLACE FUNCTION create_query (query TEXT) RETURNS tsquery LANGUAGE SQL IMMUTABLE AS $$
  SELECT to_tsquery(
    'simple',
      array_to_string(
        ARRAY(
          SELECT (quote_literal(TRIM(qpart)) || ':*')
          FROM unnest(string_to_array(query, ' ')) AS qpart
          WHERE LENGTH(TRIM(qpart)) > 0
        ),
      ' & '
    )
  );
$$;

CREATE OR REPLACE FUNCTION create_searchable (VARIADIC props TEXT[]) RETURNS tsvector LANGUAGE SQL IMMUTABLE AS $$
  SELECT to_tsvector(
    'simple',
    array_to_string(
      ARRAY(
        SELECT coalesce(prop, '')
        FROM unnest(props) AS prop
      ),
      ' '
    )
  );
$$;

CREATE OR REPLACE FUNCTION create_sortable (VARIADIC parts TEXT[]) RETURNS TEXT AS $$
  SELECT LEFT(LOWER(string_agg(coalesce(elem, ''), '~')), 255)
  FROM unnest(parts) AS elem;
$$ LANGUAGE SQL IMMUTABLE;

CREATE OR REPLACE FUNCTION jsonb_to_search_strings (data jsonb) RETURNS TEXT[] AS $$
DECLARE
  v_search_values jsonb;
  v_search_strings TEXT[];
BEGIN
  IF data IS NULL THEN
    RETURN '{}';
  END IF;

  v_search_values := jsonb_path_query_array(data, 'lax $.** ? (@.type() == "string" || @.type() == "number")');

  IF v_search_values IS NULL OR v_search_values = '[]'::jsonb THEN
    RETURN '{}';
  END IF;

  SELECT array_agg(DISTINCT elem::text)
  INTO v_search_strings
  FROM jsonb_array_elements(v_search_values) elem;

  RETURN v_search_strings;
END;
$$ LANGUAGE PLPGSQL IMMUTABLE;

CREATE OR REPLACE FUNCTION jsonb_to_search_string (data jsonb) RETURNS TEXT AS $$
BEGIN
  RETURN array_to_string(jsonb_to_search_strings(data), ' ');
END;
$$ LANGUAGE PLPGSQL IMMUTABLE;

CREATE OR REPLACE FUNCTION jsonb_to_tsvector(data jsonb) RETURNS tsvector AS $$
BEGIN
  RETURN to_tsvector('simple', array_to_string(jsonb_to_search_strings(data), ' '));
END;
$$ LANGUAGE PLPGSQL IMMUTABLE;

CREATE OR REPLACE FUNCTION trigger_modified_at () RETURNS TRIGGER AS $$
BEGIN
  NEW.modified_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE PLPGSQL;

CREATE OR REPLACE FUNCTION to_iso8601 (val TIMESTAMPTZ) RETURNS TEXT AS $$
BEGIN
  RETURN to_char(val, 'YYYY-MM-DD"T"HH24:MI:SSOF');
END
$$ LANGUAGE PLPGSQL IMMUTABLE;
