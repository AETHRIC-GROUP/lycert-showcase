-- 0002_create_tenants.sql
-- Top-level entity. One row per software company using Lycert.
-- HARD GATE: dpa_signed_at must be set before any data processing is allowed.
-- This constraint is enforced in application code, not just here.

CREATE TABLE tenants (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text          NOT NULL,
  slug                  text          NOT NULL UNIQUE,
  plan_tier             plan_tier     NOT NULL DEFAULT 'starter',
  stripe_customer_id    text,
  dpa_signed_at         timestamptz,
  dpa_signed_by         text,
  fcra_review_completed boolean       NOT NULL DEFAULT false,
  onboarding_complete   boolean       NOT NULL DEFAULT false,
  created_at            timestamptz   NOT NULL DEFAULT now(),
  updated_at            timestamptz   NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

-- Tenants can only see their own row.
-- tenant_id IS the row id for this table — use id directly.
CREATE POLICY "tenants_self_only"
  ON tenants FOR ALL TO authenticated
  USING (id = (auth.jwt() ->> 'tenant_id')::uuid)
  WITH CHECK (id = (auth.jwt() ->> 'tenant_id')::uuid);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenants_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
