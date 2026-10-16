-- 0024_extend_enrichment_provider_enum.sql
-- Extends the enrichment_provider enum for the V2 waterfall (LYCERT_WATERFALL_ENRICHMENT_V2.md).
--
-- The enum was created in 0001 as ('clay','pdl','apollo'). The V2 waterfall adds five
-- new providers, all of which write enrichment_provider = provider_key. Without these
-- values the inserts in the new clients would fail at runtime.
--
-- Also adds 'pdl_identify': orchestrator._run_identify_fallback already writes this value
-- (services/enrichment/orchestrator.py), but it was never added to the enum — a latent bug
-- that would error the moment the PDL Identify tertiary path fired. Folding it in here.
--
-- NOTE on transactions: ALTER TYPE ... ADD VALUE is supported in PostgreSQL 12+ (Supabase
-- runs PG15). The new values are NOT referenced by any statement in this or the other 0025-0028
-- migrations (the provider registry keys provider rows by TEXT, not by this enum), so the
-- "new enum value cannot be used in the same transaction" restriction does not apply here.

ALTER TYPE enrichment_provider ADD VALUE IF NOT EXISTS 'zerobounce';
ALTER TYPE enrichment_provider ADD VALUE IF NOT EXISTS 'hunter';
ALTER TYPE enrichment_provider ADD VALUE IF NOT EXISTS 'reversecontact';
ALTER TYPE enrichment_provider ADD VALUE IF NOT EXISTS 'datagma';
ALTER TYPE enrichment_provider ADD VALUE IF NOT EXISTS 'fullenrich';
ALTER TYPE enrichment_provider ADD VALUE IF NOT EXISTS 'pdl_identify';
