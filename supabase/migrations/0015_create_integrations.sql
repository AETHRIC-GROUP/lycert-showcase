-- 0015_create_integrations.sql
-- Per-tenant integration configurations.
-- credentials_encrypted stores AES-encrypted API keys — NEVER plaintext.

CREATE TABLE integrations (
  id                    uuid               PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid               NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  integration_type      integration_type   NOT NULL,
  status                integration_status NOT NULL DEFAULT 'disconnected',
  credentials_encrypted text,
  config                jsonb,
  last_sync_at          timestamptz,
  error_message         text,
  created_at            timestamptz        NOT NULL DEFAULT now(),
  updated_at            timestamptz        NOT NULL DEFAULT now(),

  UNIQUE(tenant_id, integration_type)
);

-- RLS
ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "integrations_tenant_isolation"
  ON integrations FOR ALL TO authenticated
  USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
  WITH CHECK (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

-- credentials_encrypted must never be returned to the client layer
-- Application code uses service_role to read credentials for outbound API calls only

CREATE TRIGGER integrations_updated_at
  BEFORE UPDATE ON integrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
