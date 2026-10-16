-- 0025_provider_registry.sql
-- LYCERT_WATERFALL_ENRICHMENT_V2.md Part 3.1 (doc number 0021; renumbered — 0021-0023 already taken).
-- Global registry of enrichment providers + their default waterfall order.
--
-- RLS note: the V2 doc says "no RLS" for this global table, but CLAUDE.md mandates RLS on
-- every table with no exceptions. Reconciled the same way as the existing global table
-- sub_processor_registry (0013): RLS ENABLED with a read-only policy for authenticated users.
-- Writes happen via the service role (which bypasses RLS), so tenants get read-only access —
-- exactly the doc's stated intent ("read-only to tenants"). Logged in DECISIONS.md.

CREATE TABLE enrichment_providers (
    id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_key             text        UNIQUE NOT NULL,   -- 'zerobounce','hunter','reversecontact','datagma','pdl','fullenrich','apollo'
    display_name             text        NOT NULL,
    provider_type            text        NOT NULL,          -- 'validation' | 'enrichment'
    execution_mode           text        NOT NULL,          -- 'sync' | 'async'
    enabled                  boolean     NOT NULL DEFAULT true,
    default_position         integer,                       -- waterfall order; NULL for the validation stage
    cost_per_success_usd     numeric(8, 4),
    returns_education        boolean     NOT NULL DEFAULT false,
    returns_employment_dates boolean     NOT NULL DEFAULT false,
    notes                    text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE enrichment_providers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "enrichment_providers_read_all"
  ON enrichment_providers FOR SELECT TO authenticated
  USING (true);

CREATE TRIGGER enrichment_providers_updated_at
  BEFORE UPDATE ON enrichment_providers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed rows (Part 3.1). Stage 0 (validation) has NULL default_position.
INSERT INTO enrichment_providers
  (provider_key, display_name, provider_type, execution_mode, enabled, default_position,
   cost_per_success_usd, returns_education, returns_employment_dates, notes) VALUES
  ('zerobounce',     'ZeroBounce',     'validation', 'sync',  true,  NULL, 0.0060, false, false,
   'Stage 0 email validation gate. Runs before any paid lookup. Results cached 180 days.'),
  ('hunter',         'Hunter',         'enrichment', 'sync',  true,  1,    0.0040, false, false,
   'Cheap first pass. No education, no employment dates — always PARTIAL, never stops the waterfall.'),
  ('reversecontact', 'ReverseContact', 'enrichment', 'sync',  true,  2,    0.0300, true,  true,
   'Personal-email specialist. Returns full profile incl. education + dates. Can be COMPLETE. 15 rps.'),
  ('datagma',        'Datagma',        'enrichment', 'sync',  true,  3,    0.0300, true,  true,
   'Real-time unique-find provider. GDPR-positioned (no stored DB). Can be COMPLETE. phoneFull never true.'),
  ('pdl',            'People Data Labs','enrichment','sync',  true,  4,    0.2800, true,  true,
   'Deepest, most structured education data; highest cost; lowest personal-email hit rate. Runs after specialists.'),
  ('fullenrich',     'FullEnrich',     'enrichment', 'async', true,  5,    0.0500, false, false,
   'Async waterfall-of-waterfalls final sweep (webhook delivery). Education provider-dependent. Charged only on success.'),
  ('apollo',         'Apollo',         'enrichment', 'sync',  false, 6,    0.0000, false, false,
   'DISABLED. People Enrichment requires a paid plan (no free tier). No education data. May return as enterprise add-on.');
