-- 0022_enrichment_budget_columns.sql
-- Per-tenant enrichment budget controls on tenant_scoring_config.

ALTER TABLE tenant_scoring_config
  ADD COLUMN IF NOT EXISTS monthly_enrichment_budget integer DEFAULT 500;
-- Max enrichments per calendar month. NULL = unlimited (enterprise only).

ALTER TABLE tenant_scoring_config
  ADD COLUMN IF NOT EXISTS enrichment_auto_trigger boolean NOT NULL DEFAULT true;
-- false = enrichment runs only when manually triggered by manager/admin.
