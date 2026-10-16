-- 0006_create_subscribers.sql
-- Core entity. One row per EDU subscriber per tenant.

CREATE TABLE subscribers (
  id                       uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid             NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  external_id              text,
  email                    text             NOT NULL,
  name                     text,
  account_name             text,
  account_country          text,
  institution_name         text,
  institution_location     text,
  stated_graduation_date   date,
  plan_name                text,
  plan_type                plan_type        NOT NULL DEFAULT 'edu',
  subscription_start_date  date,
  subscription_end_date    date,
  renewal_date             date,
  auto_renew               boolean          NOT NULL DEFAULT false,
  days_before_last_renewal integer,
  lifecycle_stage          lifecycle_stage  NOT NULL DEFAULT 'active_student',
  last_enriched_at         timestamptz,
  enrichment_provider      enrichment_provider,
  last_scored_at           timestamptz,
  created_at               timestamptz      NOT NULL DEFAULT now(),
  updated_at               timestamptz      NOT NULL DEFAULT now(),

  UNIQUE(tenant_id, email)
);

CREATE INDEX idx_subscribers_tenant_id ON subscribers(tenant_id);
CREATE INDEX idx_subscribers_lifecycle_stage ON subscribers(tenant_id, lifecycle_stage);
CREATE INDEX idx_subscribers_graduation ON subscribers(tenant_id, stated_graduation_date);

-- RLS
ALTER TABLE subscribers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "subscribers_tenant_isolation"
  ON subscribers FOR ALL TO authenticated
  USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
  WITH CHECK (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

CREATE TRIGGER subscribers_updated_at
  BEFORE UPDATE ON subscribers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
