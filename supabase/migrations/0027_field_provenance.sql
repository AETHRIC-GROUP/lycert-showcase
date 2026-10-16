-- 0027_field_provenance.sql
-- LYCERT_WATERFALL_ENRICHMENT_V2.md Part 3.3 (doc number 0023; renumbered).
-- Per-field provenance + cascade outcome tracking on subscriber_enrichment.
-- A final record may be merged from 2+ providers, so each field records its source.
--
-- The existing enrichment_provider column now means "provider that supplied the majority of
-- fields" — kept for backward compatibility with the dashboard.

ALTER TABLE subscriber_enrichment
  ADD COLUMN IF NOT EXISTS field_provenance jsonb DEFAULT '{}'::jsonb;
-- e.g. {"li_job_title":"reversecontact","li_education_end_date":"pdl","li_country":"hunter"}

ALTER TABLE subscriber_enrichment
  ADD COLUMN IF NOT EXISTS providers_attempted jsonb DEFAULT '[]'::jsonb;
-- ordered list with outcomes:
-- [{"provider":"hunter","outcome":"partial"},{"provider":"reversecontact","outcome":"complete"}]

ALTER TABLE subscriber_enrichment
  ADD COLUMN IF NOT EXISTS completeness text DEFAULT 'miss';
-- 'complete' | 'partial' | 'miss'

ALTER TABLE subscriber_enrichment
  ADD COLUMN IF NOT EXISTS pending_async_provider text;
-- 'fullenrich' while awaiting webhook; NULL otherwise
