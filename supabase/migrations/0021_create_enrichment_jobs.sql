-- 0021_create_enrichment_jobs.sql
-- Tracks all enrichment operations: status, credit consumption, cost.
-- Used for monitoring, budget enforcement, and retry logic.

CREATE TABLE enrichment_jobs (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_type                text        NOT NULL,
  -- 'single' / 'batch' / 'scheduled' / 'manual'
  trigger_reason          text,
  -- 'lifecycle_trigger' / 'manual' / 'scheduled' / 'onboarding'
  status                  text        NOT NULL DEFAULT 'queued',
  -- 'queued' / 'running' / 'completed' / 'failed'
  subscriber_ids          jsonb,      -- array of subscriber UUIDs in this job
  total_count             integer,
  success_count           integer     NOT NULL DEFAULT 0,
  miss_count              integer     NOT NULL DEFAULT 0,  -- 404 responses (free)
  low_quality_count       integer     NOT NULL DEFAULT 0,  -- likelihood < 4
  error_count             integer     NOT NULL DEFAULT 0,
  pdl_credits_consumed    integer     NOT NULL DEFAULT 0,
  apollo_credits_consumed integer     NOT NULL DEFAULT 0,
  estimated_cost_usd      numeric(10, 4),
  started_at              timestamptz,
  completed_at            timestamptz,
  error_message           text,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_enrichment_jobs_tenant ON enrichment_jobs(tenant_id);
CREATE INDEX idx_enrichment_jobs_status ON enrichment_jobs(status);

ALTER TABLE enrichment_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "enrichment_jobs_tenant_isolation"
  ON enrichment_jobs FOR ALL TO authenticated
  USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
  WITH CHECK (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);
