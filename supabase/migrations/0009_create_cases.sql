-- 0009_create_cases.sql
-- Human review record. Created when a subscriber is scored Tier 1 or Tier 2.
-- review_duration_seconds: tracks time spent — guards against rubber-stamping (GDPR Article 22).

CREATE TABLE cases (
  id                       uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscriber_id            uuid          NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  score_id                 uuid          NOT NULL REFERENCES subscriber_scores(id) ON DELETE RESTRICT,
  status                   case_status   NOT NULL DEFAULT 'pending_review',
  assigned_to              uuid          REFERENCES tenant_users(id) ON DELETE SET NULL,
  opened_at                timestamptz   NOT NULL DEFAULT now(),
  reviewed_at              timestamptz,
  review_duration_seconds  integer,
  decision                 case_decision NOT NULL DEFAULT 'pending',
  decision_note            text,
  decided_by               uuid          REFERENCES tenant_users(id) ON DELETE SET NULL,
  decided_at               timestamptz,
  closed_at                timestamptz,
  updated_at               timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX idx_cases_tenant_status    ON cases(tenant_id, status);
CREATE INDEX idx_cases_subscriber       ON cases(subscriber_id);
CREATE INDEX idx_cases_assigned_to      ON cases(tenant_id, assigned_to);

-- RLS
ALTER TABLE cases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cases_tenant_isolation"
  ON cases FOR ALL TO authenticated
  USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
  WITH CHECK (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

CREATE TRIGGER cases_updated_at
  BEFORE UPDATE ON cases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
