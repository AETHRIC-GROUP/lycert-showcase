-- 0007_create_subscriber_enrichment.sql
-- Stores only extracted fields from enrichment. Raw JSON NEVER stored (GDPR data minimisation).
-- delete_at is set to enriched_at + 30 days. A cron job deletes records past this date.

CREATE TABLE subscriber_enrichment (
  id                            uuid                PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id                 uuid                NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  tenant_id                     uuid                NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  linkedin_profile_url          text,
  li_current_employer_name      text,
  li_current_employer_domain    text,
  li_current_employer_linkedin_url text,
  li_job_start_date             date,
  li_job_end_date               date,               -- NULL = currently employed
  li_job_title                  text,
  li_education_institution      text,
  li_education_end_date         date,
  li_country                    text,
  li_state                      text,
  li_city                       text,
  enrichment_provider           enrichment_provider NOT NULL,
  enriched_at                   timestamptz         NOT NULL DEFAULT now(),
  delete_at                     timestamptz         NOT NULL              -- enriched_at + 30 days, set by application
);

CREATE INDEX idx_subscriber_enrichment_subscriber ON subscriber_enrichment(subscriber_id);
CREATE INDEX idx_subscriber_enrichment_delete_at  ON subscriber_enrichment(delete_at);

-- RLS
ALTER TABLE subscriber_enrichment ENABLE ROW LEVEL SECURITY;

CREATE POLICY "subscriber_enrichment_tenant_isolation"
  ON subscriber_enrichment FOR ALL TO authenticated
  USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
  WITH CHECK (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);
