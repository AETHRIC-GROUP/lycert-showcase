-- 0005_create_tenant_brand_config.sql
-- Brand tokens for email rendering. One row per tenant.

CREATE TABLE tenant_brand_config (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  logo_url         text,
  primary_color    text,
  secondary_color  text,
  font_family      text,
  sender_name      text,
  sender_email     text,
  reply_to_email   text,
  email_footer_text text,
  approved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE tenant_brand_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_brand_config_tenant_isolation"
  ON tenant_brand_config FOR ALL TO authenticated
  USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
  WITH CHECK (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

CREATE TRIGGER tenant_brand_config_updated_at
  BEFORE UPDATE ON tenant_brand_config
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
