-- 0008_create_subscriber_scores.sql
-- One score record per scoring run per subscriber. APPEND-ONLY — never update.
-- Immutability is a legal requirement: the audit trail depends on score history being tamper-proof.

CREATE TABLE subscriber_scores (
  id                        uuid                  PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id             uuid                  NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  tenant_id                 uuid                  NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scored_at                 timestamptz           NOT NULL DEFAULT now(),
  total_score               integer               NOT NULL CHECK (total_score >= 0 AND total_score <= 100),
  confidence_tier           integer               NOT NULL CHECK (confidence_tier IN (0, 1, 2, 3)),
  tier_label                text                  NOT NULL,
  data_confidence           data_confidence_level NOT NULL,
  primary_signal            text,
  supporting_signals        text,
  signals_count             integer               NOT NULL DEFAULT 0,
  signals_fired             text,
  data_gaps                 text,
  aec_professional_confirmed boolean              NOT NULL DEFAULT false,
  ai_explanation            text,
  recommended_action        text                  NOT NULL,
  scoring_version           text                  NOT NULL DEFAULT '1.0.0'
);

CREATE INDEX idx_subscriber_scores_subscriber ON subscriber_scores(subscriber_id, scored_at DESC);
CREATE INDEX idx_subscriber_scores_tenant     ON subscriber_scores(tenant_id, confidence_tier);

-- RLS — read/insert only for authenticated users in the same tenant
ALTER TABLE subscriber_scores ENABLE ROW LEVEL SECURITY;

CREATE POLICY "subscriber_scores_tenant_isolation"
  ON subscriber_scores FOR ALL TO authenticated
  USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
  WITH CHECK (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

-- APPEND-ONLY: no updates or deletes from authenticated users
-- Service role can still delete for data erasure (SAR/GDPR right to erasure)
CREATE POLICY "subscriber_scores_no_update"
  ON subscriber_scores FOR UPDATE TO authenticated
  USING (false);

CREATE POLICY "subscriber_scores_no_delete"
  ON subscriber_scores FOR DELETE TO authenticated
  USING (false);
