-- 0043_verification_documents.sql
-- LYCERT_DOCUMENT_REVIEW_ARCHITECTURE.md Part 4 (doc number verification_0010; repo is at 0042 → 0043).
-- Verification waterfall STEP 5: document review / OCR / forgery detection. Build DORMANT + GATED (Part 9):
-- nothing ingests a real document until LYCERT_DOC_REVIEW_ENABLED=true + per-tenant legal sign-off + DPIA.
--
-- Process-and-purge (Part 0 Truth 2 / Part 5): store the MINIMAL extracted fields + boolean/enum forensic
-- flags + verdict + perceptual hash — NEVER the raw image beyond the processing window (24h HARD ceiling;
-- target deletion minutes after verdict, enforced by the purge worker). No photo / signature / national ID /
-- full DOB / financial amounts / address ever persisted. Document confidence is HARD-CAPPED at 'medium'.
--
-- STAGING-ONLY for now (same prod override + ledger as 0037–0042; 0024→0043 prod-promotion bundle).

CREATE TABLE verification_documents (
    id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id            uuid        NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    consent_id               uuid        NOT NULL REFERENCES verification_consents(id), -- document-specific Art.9 consent (Stage A)

    -- Transient raw-file ref (private bucket key). Nulled on purge — never a long-term store.
    transient_storage_ref    text,
    storage_delete_at        timestamptz NOT NULL,            -- now()+24h HARD ceiling; target: minutes post-verdict
    purged_at                timestamptz,                     -- when the raw file was actually destroyed

    doc_type                 text,                            -- 'student_id'|'enrollment_cert'|'tuition_bill'|'unknown'
    issuer_institution       text,
    issuer_country           text,
    -- Extracted MINIMAL fields (Part 2 Stage C / Part 5.3) — no images, no IDs, no financial amounts.
    extracted_name           text,
    extracted_institution    text,
    extracted_enrollment_status text,
    extracted_enrollment_end date,
    extracted_doc_issue_date date,
    age_eligible             boolean,                         -- boolean only; never store DOB

    -- Forensic output (Part 2 Stage D) — booleans/enums/score, never the image.
    tamper_risk_score        numeric(4,3),                    -- 0..1
    flag_font_anomaly        boolean     NOT NULL DEFAULT false,
    flag_template_deviation  boolean     NOT NULL DEFAULT false,
    flag_metadata_anomaly    boolean     NOT NULL DEFAULT false,
    flag_copy_move           boolean     NOT NULL DEFAULT false,
    flag_composite           boolean     NOT NULL DEFAULT false,
    flag_color_inconsistency boolean     NOT NULL DEFAULT false,
    flag_repeat_document     boolean     NOT NULL DEFAULT false,
    perceptual_hash          text,                            -- repeat-document detection across submissions
    physical_security_uncheckable boolean NOT NULL DEFAULT true,  -- ALWAYS true (image-only) — permanent gap

    -- Cross-reference output (Part 2 Stage E).
    xref_institution_real    boolean,
    xref_name_matches_claim  boolean,
    xref_institution_matches_claim boolean,
    xref_dates_consistent    boolean,

    -- Decision (Part 2 Stage F) — human-in-the-loop, MEDIUM cap.
    machine_recommendation   text,                            -- 'enrolled_medium'|'inconclusive'|'suspected_tamper'
    reviewer_id              uuid REFERENCES tenant_users(id),
    reviewer_decision        text,                            -- 'approved'|'rejected'|'needs_more'
    reviewer_decided_at      timestamptz,
    review_status            text        NOT NULL DEFAULT 'pending_ocr', -- 'pending_ocr'|'pending_review'|'decided'
    confidence               text        NOT NULL DEFAULT 'medium',      -- HARD CAP: never above 'medium'
    created_at               timestamptz NOT NULL DEFAULT now()
);

-- Purge worker hot path: documents whose raw file is due for deletion and not yet purged.
CREATE INDEX idx_verification_documents_purge
  ON verification_documents (storage_delete_at)
  WHERE purged_at IS NULL AND transient_storage_ref IS NOT NULL;
CREATE INDEX idx_verification_documents_subscriber ON verification_documents (subscriber_id);
CREATE INDEX idx_verification_documents_phash ON verification_documents (perceptual_hash) WHERE perceptual_hash IS NOT NULL;

ALTER TABLE verification_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ver_docs_tenant" ON verification_documents
  FOR ALL TO authenticated
  USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
  WITH CHECK (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

-- Private, non-public bucket for the transient raw files. Access is service-role + time-boxed signed URLs
-- only (no public policies). The purge worker deletes objects here on the 24h ceiling.
INSERT INTO storage.buckets (id, name, public)
VALUES ('verification-documents', 'verification-documents', false)
ON CONFLICT (id) DO NOTHING;
