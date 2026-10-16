-- 0011_create_audit_logs.sql
-- Immutable audit trail. Every action in the system is logged here.
-- APPEND-ONLY: no updates or deletes from authenticated users.
-- Retained for 24 months per GDPR retention policy.

CREATE TABLE audit_logs (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_id      uuid        REFERENCES tenant_users(id) ON DELETE SET NULL, -- null for system actions
  actor_type    actor_type  NOT NULL DEFAULT 'user',
  action        text        NOT NULL, -- e.g. 'case.approved', 'subscriber.enriched', 'email.sent'
  resource_type text        NOT NULL, -- e.g. 'case', 'subscriber', 'email_send'
  resource_id   uuid,
  metadata      jsonb,
  ip_address    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_logs_tenant      ON audit_logs(tenant_id, created_at DESC);
CREATE INDEX idx_audit_logs_resource    ON audit_logs(tenant_id, resource_type, resource_id);
CREATE INDEX idx_audit_logs_actor       ON audit_logs(tenant_id, actor_id);

-- RLS
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "audit_logs_tenant_isolation"
  ON audit_logs FOR ALL TO authenticated
  USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
  WITH CHECK (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

-- APPEND-ONLY: no updates or deletes from authenticated users
-- Service role bypasses these for GDPR erasure (anonymise, not delete)
CREATE POLICY "audit_logs_no_update"
  ON audit_logs FOR UPDATE TO authenticated
  USING (false);

CREATE POLICY "audit_logs_no_delete"
  ON audit_logs FOR DELETE TO authenticated
  USING (false);
