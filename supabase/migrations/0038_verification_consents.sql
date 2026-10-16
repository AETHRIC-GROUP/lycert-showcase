-- 0038_verification_consents.sql
-- LYCERT_VERIFICATION_ARCHITECTURE.md Part 6.1 — the legal spine of the verification layer.
--
-- FERPA requires consent to be SIGNED (electronic OK), DATED, SCOPED, PURPOSE-STATED, RECIPIENT-IDENTIFIED
-- (the five fields). No `requires_consent=true` provider (NSC/HEDD/SSO/DigiLocker) may run without an
-- active, unexpired, unrevoked consent row — enforced IN CODE (lib/verification/consent.ts), not just UI.
--
-- ⚠ LEGAL-REVIEW GATE (Part 9.1.2): the consent *text* (consent_text_version content) is a PLACEHOLDER
-- pending legal review of the FERPA consent wording + GDPR consent basis. This migration builds the
-- storage + enforcement structure; no live consent-gated authoritative check runs until the text is
-- signed off and the providers are enabled.
--
-- GDPR: the lawful basis for verification processing is the subscriber's CONSENT captured here (stronger
-- than the legitimate-interest basis used for enrichment). Education records may be sensitive processing
-- in some jurisdictions — the consent basis covers it. Document in the LIA/ROPA.

CREATE TABLE verification_consents (
    id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id        uuid        NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    scope                text        NOT NULL,   -- what records, e.g. 'enrollment_status'
    purpose              text        NOT NULL,   -- 'continued EDU eligibility verification for {client}'
    recipient            text        NOT NULL,   -- 'National Student Clearinghouse' / institution
    consent_text_version text        NOT NULL,   -- exact version of the consent text the subscriber agreed to
    granted_at           timestamptz NOT NULL,
    granted_via          text,                   -- 'hosted_verification_flow'
    ip_address           text,
    revoked_at           timestamptz,            -- consent is revocable
    expires_at           timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_verification_consents_tenant ON verification_consents(tenant_id);
-- Hot path: "is there an ACTIVE consent for this subscriber+scope?" (the code-level enforcement query).
CREATE INDEX idx_verification_consents_active
  ON verification_consents (subscriber_id, scope)
  WHERE revoked_at IS NULL;

ALTER TABLE verification_consents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "verification_consents_tenant_isolation"
  ON verification_consents FOR ALL TO authenticated
  USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
  WITH CHECK (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);
