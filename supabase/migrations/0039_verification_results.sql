-- 0039_verification_results.sql
-- LYCERT_VERIFICATION_ARCHITECTURE.md Part 5 (doc number `verification_0002`) + Part 6.2 data minimisation.
--
-- One row per verification attempt. Records the RESULT + method + confidence — NEVER the underlying
-- education-record payload (Part 6.2 / Part 10): no transcripts, GPA, course lists. `raw_reference` holds
-- only the provider's request id, never a PII body (extract→discard, same discipline as enrichment).
--
-- The asymmetry rule (Part 2.1) is data, not just code: `status` distinguishes the authoritative
-- 'not_enrolled' (only NSC/HEDD/SSO may assert it) from 'unable_to_confirm' (NEVER an adverse signal).

CREATE TABLE verification_results (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id     uuid        NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    provider_key      text        NOT NULL REFERENCES verification_providers(provider_key),
    method_class      text        NOT NULL,   -- snapshot at time of check: authoritative|semi_authoritative|document
    status            text        NOT NULL,   -- enrolled|not_enrolled|unable_to_confirm|control_proven|document_pending|error
    confidence        text        NOT NULL,   -- authoritative|semi_authoritative|medium|low
    enrollment_status text,                    -- full-time/half-time/etc. when the source provides it
    enrollment_end_date date,                  -- when the source provides it
    as_of_date        date,                    -- the date the source's data is current to
    consent_id        uuid        REFERENCES verification_consents(id) ON DELETE SET NULL,
    raw_reference     text,                    -- provider's request id ONLY; NEVER a raw PII payload
    checked_at        timestamptz NOT NULL DEFAULT now(),
    delete_at         timestamptz              -- retention per Part 6.2 (default 90d, set by app)
);

CREATE INDEX idx_verification_results_tenant ON verification_results(tenant_id);
CREATE INDEX idx_verification_results_subscriber ON verification_results(subscriber_id, checked_at DESC);
-- Retention sweep finds rows past their delete_at.
CREATE INDEX idx_verification_results_delete_at ON verification_results(delete_at) WHERE delete_at IS NOT NULL;

ALTER TABLE verification_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "verification_results_tenant_isolation"
  ON verification_results FOR ALL TO authenticated
  USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
  WITH CHECK (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);
