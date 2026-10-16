-- 0026_tenant_waterfall_config.sql
-- LYCERT_WATERFALL_ENRICHMENT_V2.md Part 3.2 (doc number 0022; renumbered).
-- Per-tenant override of the global waterfall order. Empty for a tenant = use the global
-- default order from enrichment_providers.default_position.

CREATE TABLE tenant_waterfall_config (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    provider_key text        NOT NULL REFERENCES enrichment_providers(provider_key) ON DELETE CASCADE,
    position     integer     NOT NULL,
    enabled      boolean     NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, provider_key),
    UNIQUE (tenant_id, position)
);

CREATE INDEX idx_tenant_waterfall_config_tenant ON tenant_waterfall_config(tenant_id);

ALTER TABLE tenant_waterfall_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_waterfall_config_tenant_isolation"
  ON tenant_waterfall_config FOR ALL TO authenticated
  USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
  WITH CHECK (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

CREATE TRIGGER tenant_waterfall_config_updated_at
  BEFORE UPDATE ON tenant_waterfall_config
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
