-- 0014_create_tenant_field_mappings.sql
-- Maps each tenant's column names to Lycert's canonical field names.
-- This is how different billing systems (Zuora, Chargebee, Stripe, etc.) get normalised
-- into a consistent schema for scoring.
--
-- Canonical field reference (from CEDS score_accounts.py):
--   renewal_delta_days       ← "Difference Before Last Renewal" (partner/Zuora)
--   stated_graduation_date   ← "Expected Graduation" (the design partner)
--   proof_submission_date    ← "Proof Submission Date" (the design partner)
--   subscription_start_date  ← "Subscription Start Date"
--   subscription_end_date    ← "Subscription End Date"
--   email                    ← "email"
--   subscriber_name          ← "Contact Name" (the design-partner Salesforce)
--   account_name             ← "Account Name"
--   institution_name         ← "Institution Name"
--   institution_location     ← "Institution Location"
--   account_country          ← "Account Location" (last comma segment)
--   li_job_company_name      ← "LI Job Company Name" (Clay enrichment)
--   li_job_end_date          ← "LI Job End Date"
--   li_job_title             ← "LI Title"
--   li_education_date_range  ← "LI Education Date Range" (free text, year extracted)
--   li_company_domain        ← "Company Domain Name"

CREATE TABLE tenant_field_mappings (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  canonical_field      text        NOT NULL,
  client_field_name    text,
  calculation_formula  text,       -- e.g. '(last_renewal_date - stated_graduation_date).days'
  source_fields        text[],     -- source fields used for calculated values
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  UNIQUE(tenant_id, canonical_field)
);

-- RLS
ALTER TABLE tenant_field_mappings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_field_mappings_tenant_isolation"
  ON tenant_field_mappings FOR ALL TO authenticated
  USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
  WITH CHECK (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

CREATE TRIGGER tenant_field_mappings_updated_at
  BEFORE UPDATE ON tenant_field_mappings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
