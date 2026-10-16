-- 0016_fix_custom_access_token_hook.sql
-- Bug: the original hook set 'role' in JWT claims, overwriting the 'authenticated'
-- database role that PostgREST requires. PostgREST tried SET ROLE owner/viewer/etc,
-- found no such Postgres role, and returned 401 on every REST call.
-- Fix: use 'user_role' for the application-level role claim instead.

CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  claims jsonb;
  tu     tenant_users%ROWTYPE;
BEGIN
  claims := event -> 'claims';

  SELECT *
    INTO tu
    FROM tenant_users
   WHERE user_id = (event ->> 'user_id')::uuid
   LIMIT 1;

  IF FOUND THEN
    claims := jsonb_set(claims, '{tenant_id}', to_jsonb(tu.tenant_id::text));
    claims := jsonb_set(claims, '{user_role}', to_jsonb(tu.role::text));
  END IF;

  RETURN jsonb_set(event, '{claims}', claims);
END;
$$;
