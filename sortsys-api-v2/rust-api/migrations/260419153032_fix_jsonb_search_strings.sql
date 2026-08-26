CREATE FUNCTION public.jsonb_search_strings (data jsonb) RETURNS TEXT[] LANGUAGE plpgsql IMMUTABLE AS $_$
BEGIN
  RETURN jsonb_to_search_strings(data);
END;
    $_$;
