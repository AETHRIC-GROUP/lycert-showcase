-- 0020_create_employer_enrichment.sql
-- Secondary enrichment table for employer/company intelligence.
-- Populated for Tier 1/2 subscribers and AEC Professional Confirmed cases only.
-- Used by the Graduation Transition Engine for offer personalisation.

CREATE TABLE subscriber_employer_enrichment (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id        uuid        NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  tenant_id            uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employer_name_canonical text,
  employer_size_band   text,       -- PDL size band
  employer_headcount   integer,    -- exact headcount if available
  employer_industry    text,
  employer_founded_year integer,
  employer_total_funding bigint,   -- USD, for startup vertical
  employer_pdl_id      text,
  enriched_at          timestamptz NOT NULL DEFAULT now(),
  delete_at            timestamptz NOT NULL, -- 30-day retention, same as subscriber_enrichment
  UNIQUE(subscriber_id)
);

ALTER TABLE subscriber_employer_enrichment ENABLE ROW LEVEL SECURITY;

CREATE POLICY "employer_enrich_tenant_isolation"
  ON subscriber_employer_enrichment FOR ALL TO authenticated
  USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
  WITH CHECK (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);
