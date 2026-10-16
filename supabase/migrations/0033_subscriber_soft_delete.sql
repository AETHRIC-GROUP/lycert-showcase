-- 0033_subscriber_soft_delete.sql
-- Subscriber deletion: soft-delete (archive) by default, hard-delete (purge) as a separate explicit
-- GDPR right-to-erasure action. Both are gated to owner/admin in the API layer and written to
-- audit_logs. Soft-deleted rows stay in the table (recoverable, audit trail preserved) but are
-- hidden from every subscriber listing via a `deleted_at IS NULL` filter in the app queries.
--
-- A hard purge is a plain DELETE on subscribers; all dependent rows (subscriber_scores, cases,
-- subscriber_enrichment, subscriber_employer_enrichment) are ON DELETE CASCADE, so they go with it.

ALTER TABLE subscribers
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- Partial index: listings filter `WHERE tenant_id = ? AND deleted_at IS NULL`, so index only the
-- live rows (archived rows are a small minority and not listed on the hot path).
CREATE INDEX idx_subscribers_tenant_live
  ON subscribers (tenant_id, created_at DESC)
  WHERE deleted_at IS NULL;
