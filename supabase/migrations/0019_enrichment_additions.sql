-- 0019_enrichment_additions.sql
-- Additional columns on subscriber_enrichment for PDL-specific fields.

ALTER TABLE subscriber_enrichment ADD COLUMN IF NOT EXISTS pdl_person_id text;
-- stored for future Changelog API (Phase 5 cost optimisation)

ALTER TABLE subscriber_enrichment ADD COLUMN IF NOT EXISTS pdl_likelihood_score integer;
ALTER TABLE subscriber_enrichment ADD COLUMN IF NOT EXISTS li_job_title_levels jsonb;
-- e.g. ["entry", "senior"]

ALTER TABLE subscriber_enrichment ADD COLUMN IF NOT EXISTS li_employer_size text;
-- PDL size band: "1-10" / "11-50" / "51-200" / "201-500" / "501-1000" / "1001-5000" / "5001-10000" / "10001+"

ALTER TABLE subscriber_enrichment ADD COLUMN IF NOT EXISTS li_employer_industry text;
ALTER TABLE subscriber_enrichment ADD COLUMN IF NOT EXISTS li_skills jsonb;
-- first 10 skills from PDL, stored as string array

ALTER TABLE subscriber_enrichment ADD COLUMN IF NOT EXISTS provider_miss_reason text;
-- 'low_quality' (likelihood < 4) / 'no_match' (404) / null
