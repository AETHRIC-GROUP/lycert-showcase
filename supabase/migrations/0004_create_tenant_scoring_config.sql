-- 0004_create_tenant_scoring_config.sql
-- Per-tenant configurable scoring parameters.
-- Defaults match the CEDS model (score_accounts.py, verified 2026-06-05).
-- One row per tenant, created at onboarding.

CREATE TABLE tenant_scoring_config (
  id                              uuid      PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                       uuid      NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,

  -- Tier thresholds
  tier1_threshold                 integer   NOT NULL DEFAULT 65,
  tier2_threshold                 integer   NOT NULL DEFAULT 40,
  tier3_threshold                 integer   NOT NULL DEFAULT 20,

  -- Grace period after graduation before scoring begins
  grace_period_days               integer   NOT NULL DEFAULT 90,

  -- Tier A signal weights (billing data)
  -- A1: max points for renewal 365d+ after graduation. Sub-tiers scale proportionally.
  signal_a1_weight                integer   NOT NULL DEFAULT 35,
  signal_a2_weight                integer   NOT NULL DEFAULT 20,
  signal_a3_weight                integer   NOT NULL DEFAULT 20,
  signal_a4_weight                integer   NOT NULL DEFAULT 10,

  -- Tier B signal weights (user-submitted data)
  signal_b1_personal_weight       integer   NOT NULL DEFAULT 8,
  signal_b2_weight                integer   NOT NULL DEFAULT 20,
  signal_b3_weight                integer   NOT NULL DEFAULT 8,

  -- Tier C signal weights (LinkedIn enrichment)
  signal_c1_weight                integer   NOT NULL DEFAULT 25,
  signal_c2_strong_weight         integer   NOT NULL DEFAULT 20,
  signal_c2_weak_weight           integer   NOT NULL DEFAULT 10,
  signal_c3_weight                integer   NOT NULL DEFAULT 15,
  signal_c4_weight                integer   NOT NULL DEFAULT 10,

  -- Exculpatory signal adjustments (stored as negative integers)
  signal_b1_academic_exculpatory  integer   NOT NULL DEFAULT -10,
  signal_c2_student_exculpatory   integer   NOT NULL DEFAULT -15,
  signal_c3_future_exculpatory    integer   NOT NULL DEFAULT -5,
  signal_c4_academic_exculpatory  integer   NOT NULL DEFAULT -5,

  -- Vertical configuration
  vertical_tag                    text      NOT NULL DEFAULT 'aec',
  -- Values: 'aec' | 'design' | 'gaming' | 'devtools' | 'generic'

  updated_at                      timestamptz NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE tenant_scoring_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_scoring_config_tenant_isolation"
  ON tenant_scoring_config FOR ALL TO authenticated
  USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
  WITH CHECK (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

CREATE TRIGGER tenant_scoring_config_updated_at
  BEFORE UPDATE ON tenant_scoring_config
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
