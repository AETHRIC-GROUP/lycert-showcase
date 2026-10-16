-- 0037_verification_providers.sql
-- LYCERT_VERIFICATION_ARCHITECTURE.md Part 5 (doc number `verification_0001`; renumbered — the repo is
-- already at 0036, so the verification layer continues the real sequential scheme at 0037+).
--
-- The ENROLLMENT VERIFICATION layer is a NEW, SEPARATE subsystem from enrichment (Part 0): it answers
-- "is this person actually still enrolled?" from AUTHORITATIVE sources, never from LinkedIn-derived
-- enrichment. This is the global registry of verification providers + their waterfall order, mirroring
-- enrichment_providers (0025).
--
-- RLS note (same reconciliation as enrichment_providers / sub_processor_registry): the table is global,
-- but CLAUDE.md mandates RLS on every table. RLS ENABLED with a read-only policy for authenticated users;
-- writes are service-role only (bypasses RLS). Logged in DECISIONS.md.

CREATE TABLE verification_providers (
    id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_key           text        UNIQUE NOT NULL,   -- 'nsc','hedd','sso','email_loop','document','digilocker'
    display_name           text        NOT NULL,
    method_class           text        NOT NULL,          -- 'authoritative' | 'semi_authoritative' | 'document'
    country_scope          text[],                        -- ISO codes this provider covers; NULL = global (email_loop, document)
    requires_consent       boolean     NOT NULL DEFAULT true,
    can_assert_not_enrolled boolean    NOT NULL DEFAULT false,  -- only true for authoritative sources (NSC/HEDD/SSO)
    enabled                boolean     NOT NULL DEFAULT false,
    default_position       integer,                       -- waterfall order; NULL = not in the ordered cascade
    cost_per_check_usd     numeric(8, 4),
    notes                  text,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE verification_providers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "verification_providers_read_all"
  ON verification_providers FOR SELECT TO authenticated
  USING (true);

CREATE TRIGGER verification_providers_updated_at
  BEFORE UPDATE ON verification_providers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed (Part 5 + Part 2 waterfall order). Only the globally-applicable, no-external-agreement methods
-- start enabled: email_loop (Step 4) is the highest-ROI first build. NSC/HEDD/SSO/document/digilocker
-- are seeded DISABLED — each needs a commercial/data agreement and/or legal review before activation
-- (Part 9.1). default_position reflects the Part 2 waterfall: authoritative (Step 2) < SSO (Step 3) <
-- email_loop (Step 4) < document (Step 5).
INSERT INTO verification_providers
  (provider_key, display_name, method_class, country_scope, requires_consent,
   can_assert_not_enrolled, enabled, default_position, cost_per_check_usd, notes) VALUES
  ('nsc',        'National Student Clearinghouse', 'authoritative',      ARRAY['US'], true,  true,  false, 2,    NULL,
   'Step 2 (US). EnrollmentVerify/DegreeVerify Web Services. FERPA: needs signed/dated consent or returns Unable-to-Confirm. DISABLED until NSC commercial agreement + schema in hand (Part 3, Part 9.1.1). Stubbed behind the interface.'),
  ('hedd',       'HEDD (UK)',                      'authoritative',      ARRAY['GB'], true,  true,  false, 2,    NULL,
   'Step 2 (UK). Higher Education Degree Datacheck (Jisc/Prospects). Paid, consent-based, per-check. DISABLED until agreement (Part 4).'),
  ('digilocker', 'NAD / DigiLocker (India)',       'authoritative',      ARRAY['IN'], true,  true,  false, 2,    NULL,
   'Step 2 (India). Govt academic records API, consent-based. DISABLED until agreement (Part 4).'),
  ('sso',        'Institutional SSO',              'authoritative',      NULL,        true,  true,  false, 3,    NULL,
   'Step 3. SAML/OIDC/Shibboleth/Google-Workspace-edu login proves CURRENT membership. Highest authority of the friction methods; hardest to scale (per-IdP). DISABLED — build after NSC + email-loop (Part 8.2).'),
  ('email_loop', 'Institutional Email Loop',       'semi_authoritative', NULL,        false, false, true,  4,    0.0000,
   'Step 4. One-time link to a verified institutional address proves CURRENT inbox control. Global, no external agreement. Semi-authoritative (alumni-retained addresses are the known false positive). HIGHEST-ROI first build (Part 8.1).'),
  ('document',   'Document Review',                'document',           NULL,        false, false, false, 5,    NULL,
   'Step 5 fallback. Enrollment certificate / student ID / tuition bill via OCR + authenticity signals. MEDIUM confidence. DISABLED — reuses the first-time-verification OCR pipeline when that is built (Part 9.2 step 7).');
