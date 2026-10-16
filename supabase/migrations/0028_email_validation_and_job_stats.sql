-- 0028_email_validation_and_job_stats.sql
-- LYCERT_WATERFALL_ENRICHMENT_V2.md Part 1.1 + Part 3.4 (doc number 0024; renumbered).
-- Stage 0 (ZeroBounce) validation results on subscribers + per-provider stats on enrichment_jobs.

-- ── Part 1.1: ZeroBounce validation results (cached 180 days) ──────────────────
ALTER TABLE subscribers
  ADD COLUMN IF NOT EXISTS email_validation_status text;
-- 'valid' | 'invalid' | 'catch_all' | 'unknown' | 'disposable'

ALTER TABLE subscribers
  ADD COLUMN IF NOT EXISTS email_validated_at timestamptz;

ALTER TABLE subscribers
  ADD COLUMN IF NOT EXISTS email_typo_suggestion text;
-- ZeroBounce did_you_mean suggestion; surfaced in dashboard, NEVER auto-applied.

-- ── Part 3.4: per-provider cost accounting on enrichment_jobs ──────────────────
ALTER TABLE enrichment_jobs
  ADD COLUMN IF NOT EXISTS per_provider_stats jsonb DEFAULT '{}'::jsonb;
-- {"hunter":{"attempts":950,"hits":380,"cost_usd":3.80}, "reversecontact":{...}, ...}

ALTER TABLE enrichment_jobs
  ADD COLUMN IF NOT EXISTS async_pending_count integer NOT NULL DEFAULT 0;

-- Partial index to make the webhook lookup + nightly 24h timeout sweep cheap
-- (Part 4.3: "clears pending_async_provider older than 24h").
CREATE INDEX IF NOT EXISTS idx_subscriber_enrichment_pending_async
  ON subscriber_enrichment(pending_async_provider)
  WHERE pending_async_provider IS NOT NULL;
