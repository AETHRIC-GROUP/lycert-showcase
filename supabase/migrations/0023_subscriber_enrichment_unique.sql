-- 0023_subscriber_enrichment_unique.sql
-- Add UNIQUE constraint on subscriber_id so that upsert(on_conflict="subscriber_id") works.
-- One enrichment record per subscriber (latest enrichment overwrites previous).

ALTER TABLE subscriber_enrichment
  ADD CONSTRAINT uq_subscriber_enrichment_subscriber_id UNIQUE (subscriber_id);
