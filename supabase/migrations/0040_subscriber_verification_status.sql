-- 0040_subscriber_verification_status.sql
-- LYCERT_VERIFICATION_ARCHITECTURE.md Part 5 (doc number `verification_0003`).
--
-- Authoritative enrollment status ON the subscriber, kept DISTINCT from enrichment-derived signals
-- (Part 0): enrichment answers "who is this person professionally?" (indicative); these columns answer
-- "is this person actually still enrolled?" (authoritative/semi-authoritative or unverified). The scorer
-- (Part 7) reads verification_status as the top-priority V1 signal that OUTRANKS enrichment.

ALTER TABLE subscribers
  ADD COLUMN verification_status     text DEFAULT 'unverified',
    -- 'verified_enrolled' | 'verified_not_enrolled' | 'unverified' | 'verification_expired'
  ADD COLUMN verification_method     text,        -- which provider_key last confirmed
  ADD COLUMN verification_confidence text,        -- authoritative | semi_authoritative | medium
  ADD COLUMN verified_at             timestamptz,
  ADD COLUMN verification_expires_at timestamptz; -- re-verification cadence anchor (Part 9.3)

-- Re-verification cadence sweep: find subscribers whose verification has expired and needs re-running.
CREATE INDEX idx_subscribers_verification_expiry
  ON subscribers (tenant_id, verification_expires_at)
  WHERE verification_expires_at IS NOT NULL;
