-- 0003_create_tenant_users.sql
-- Maps Supabase auth users to tenants with a role.
-- Also sets up the custom JWT hook that injects tenant_id and role into JWT claims.

CREATE TABLE tenant_users (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id      uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role         user_role   NOT NULL DEFAULT 'reviewer',
  display_name text,
  email        text        NOT NULL,
  invited_at   timestamptz NOT NULL DEFAULT now(),
  accepted_at  timestamptz,
  UNIQUE(tenant_id, user_id)
);

-- RLS
ALTER TABLE tenant_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_users_tenant_isolation"
  ON tenant_users FOR ALL TO authenticated
  USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
  WITH CHECK (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

-- ── Custom JWT Claims Hook ────────────────────────────────────────────────────
-- This function is registered as a Supabase custom access token hook.
-- It injects tenant_id and role into the JWT so RLS policies can use them.
--
-- SETUP REQUIRED: After running this migration, go to:
-- Supabase Dashboard → Authentication → Hooks → Custom Access Token
-- and set the function to: public.custom_access_token_hook
--
-- Also grant the auth schema permission to call this function:
-- GRANT EXECUTE ON FUNCTION public.custom_access_token_hook TO supabase_auth_admin;
-- REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook FROM PUBLIC;
-- GRANT USAGE ON SCHEMA public TO supabase_auth_admin;

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
    claims := jsonb_set(claims, '{role}',      to_jsonb(tu.role::text));
  END IF;

  RETURN jsonb_set(event, '{claims}', claims);
END;
$$;

-- Revoke public execute — only supabase_auth_admin should call this
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.custom_access_token_hook TO supabase_auth_admin;
GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
