# LYCERT_DOCUMENT_REVIEW_ARCHITECTURE.md
**Version:** 1.0
**Date:** June 2026
**Status:** Authoritative spec for the document-review / OCR / forgery-detection pipeline (Verification waterfall STEP 5). Build DORMANT and GATED per Part 9. This EXTENDS LYCERT_VERIFICATION_ARCHITECTURE.md.
**For Claude Code:** Your dormant/gated build instinct (with the advisor) is correct and confirmed — keep it. This document specifies what goes *inside* that gated skeleton from first principles, because the skeleton must have the right shape even while dormant. Read fully before building. Do not enable upload or store any real document until Part 9's gate conditions are met.

> ⚠️ **PART 9 (build gate) SUPERSEDED (2026-10-08) by `LYCERT_BRIDGE_ARCHITECTURE.md` Part 4.4.** This
> pipeline is now **frozen permanently** (`LYCERT_DOC_REVIEW_ENABLED=false` for the foreseeable future), not
> merely gated-pending-legal-review: SheerID performs document review for its customers (Bridge Part 2.1.1,
> D1). Code, tests, and migration `0043` stay in the repo (do not delete) for a possible future "no
> verification provider" client segment, but no further work is planned here.

---

## PART 0 — THE GOVERNING JUDGMENT (Read First)

Three first-principles truths from the IDV industry shape every decision below:

**Truth 1 — Image-only verification is structurally weak, and you must NOT pretend otherwise.** The US Department of Homeland Security's Science & Technology Directorate established in July 2025 that image-based verification systems cannot assess the physical security features embedded in government-issued IDs — a high-quality fake with accurate fonts and a plausible layout can pass an image-only pipeline. Lycert receives uploaded images/PDFs, not documents in hand. Therefore Lycert's document review can NEVER be the *sole* basis for an adverse decision, and its output confidence is capped at MEDIUM by design. This is not a limitation to fix later; it is a permanent property of image-based review. The architecture treats document review as a *contributing signal that requires authoritative cross-referencing*, never as proof on its own.

**Truth 2 — The legally dangerous act is STORAGE, not OCR.** Student IDs, enrollment certificates, and tuition bills are special-category-adjacent personal data. The risk is holding a real student's ID document. The entire architecture is therefore built around **process-and-purge**: extract the minimum fields needed, derive a verdict, and destroy the raw document as fast as legally possible. The IDV industry standard pattern (e.g. Didit) is to process the data, return the result via webhook, then immediately delete the raw artifact. Lycert follows this exactly.

**Truth 3 — Document review is the LAST resort in the waterfall, used only when authoritative and semi-authoritative methods failed.** SheerID's own engine only asks for a document upload after authoritative data, SSO, and email-loop have all failed. Lycert is identical. Most subscribers should never reach this step. Building it does not mean using it often — it means having a defensible fallback for the long tail (international/personal-email students with no NSC coverage and no institutional email).

---

## PART 1 — HOW THE IDV INDUSTRY ACTUALLY DOES THIS (Verified Reference)

The pipeline below mirrors the documented architecture of established IDV/document-forensics providers (Entrust/Onfido, G2 Risk Solutions, Fortiro, ID Dataweb, iCOVER, Didit). Their common pipeline is five stages: **Capture → Classify → Extract (OCR) → Authenticate (forensics) → Cross-reference → Decision**, with raw-image purge and human review on borderline cases.

### 1.1 The forgery-detection technique landscape (exhaustive, from industry + academic sources)
Lycert's authenticity layer must account for every one of these documented attack/detection pairs:

| Forgery / attack type | Detection technique (industry-documented) |
|---|---|
| Substituted text fields (altered name, dates, enrollment status) | OCR + per-character font/kerning analysis; outlier-character detection in discriminant feature space (scan-edit-print forensics); cross-field consistency checks |
| Substituted / swapped photo | Altered-image detection; composite/region boundary analysis |
| Copy-move forgery (cloned regions) | CNN-based copy-move detection |
| Signature forgery | CNN signature-forgery classifiers |
| Masked / redacted data blocks | Masked-block detection |
| Composited image fragments | Composite-fragment detection; Delaunay layout descriptor (spatial region relationships) |
| Injected foreign elements | Injected-element detection |
| Font / typeface irregularities | Font controls; typeface-cutback analysis |
| Layout / template deviation | Template matching per issuer; zoning analysis (every expected section present & correctly placed) |
| Digital tampering (Photoshop etc.) | Image-quality analysis; metadata/EXIF inconsistency; error-level analysis; noise/compression analysis |
| Color inconsistency | Color-alignment analysis across regions |
| Physical-integrity fakes | 3D / depth analysis (NOT available to Lycert — image-only; this is a known coverage gap, see Truth 1) |
| Reused/recycled genuine document across many applicants | Repeat-document detection (hash/perceptual-hash against prior submissions) |
| Deepfake / injected synthetic media | Injection-attack detection (note: iProov reported iOS injection tooling inserting deepfake video into IDV sessions in Sept 2025 — relevant if Lycert ever adds liveness; NOT in scope for static doc review but flagged) |
| AI-generated synthetic documents | Anomaly detection across 500+ document attributes incl. ones imperceptible to humans; issuer-trait modeling |

### 1.2 The critical industry insight on auto-approval
G2 Risk Solutions' documented model: an AI learns issuer-specific traits and can auto-approve from trusted issuers, prefer photos over scans, route to the best OCR — but new document types need ~20 samples + 24h training to reach trusted assurance. **Implication for Lycert:** Lycert starts with ZERO issuer training data and thousands of different institutions worldwide. Therefore Lycert CANNOT auto-approve documents at launch. Every document that reaches this step routes to human review. Auto-approval is a far-future capability that requires a labeled corpus Lycert won't have for a long time. Do not build auto-approval. Build human-in-the-loop review with machine-generated *assistance flags*.

---

## PART 2 — THE LYCERT DOCUMENT-REVIEW PIPELINE (Six Stages)

```
                    ┌─────────────────────────────────────────────┐
                    │  GATE: LYCERT_DOC_REVIEW_ENABLED = false     │
                    │  + per-tenant legal sign-off flag            │
                    │  Nothing below runs until BOTH are true.     │
                    └─────────────────────────────────────────────┘
                                      │ (when enabled)
SUBSCRIBER reaches Step 5 (all prior verification methods failed/unavailable)
                                      │
  ┌───────────────────────────────────────────────────────────────┐
  │ STAGE A — CONSENT + CAPTURE                                    │
  │ • Explicit, document-specific consent (Art.9 explicit consent) │
  │   captured BEFORE upload widget renders. Separate from the     │
  │   email-loop/NSC consent — names "identity/enrollment document"│
  │ • Upload widget: accepts a defined whitelist (PDF/JPG/PNG/HEIC)│
  │   max size cap; client-side image-quality pre-check (blur,     │
  │   glare, edge-detection) → reject poor captures immediately    │
  │   (industry "quick feedback → re-upload" pattern, reduces      │
  │   stored bad data)                                             │
  │ • Raw file lands in a PRIVATE, encrypted bucket with an        │
  │   immediate delete_at = now()+24h (NOT 30d — see Part 5)       │
  └───────────────────────────────────────────────────────────────┘
                                      │
  ┌───────────────────────────────────────────────────────────────┐
  │ STAGE B — CLASSIFY                                             │
  │ • Determine document type (student ID / enrollment cert /      │
  │   tuition bill / other) + issuer + country + language          │
  │ • Routes to correct extraction template + correct expected-    │
  │   field set. Unknown type → flag, route to human.              │
  └───────────────────────────────────────────────────────────────┘
                                      │
  ┌───────────────────────────────────────────────────────────────┐
  │ STAGE C — EXTRACT (OCR / vision)                              │
  │ • Vision client behind a SEAM (interface). NO SDK/key wired    │
  │   at build time. The interface defines extract(image) →        │
  │   structured fields. Implementation injected later.            │
  │ • Extract ONLY the minimum fields needed for the eligibility   │
  │   decision (data minimization, Art.5(1)(c)):                   │
  │     - full name                                                │
  │     - institution name                                         │
  │     - enrollment status / dates (cert)                         │
  │     - document issue/expiry date                               │
  │     - (tuition bill) institution + term + that a payment exists│
  │ • DO NOT extract or persist: photo, signature image, national  │
  │   ID numbers, date of birth beyond age-eligibility boolean,    │
  │   financial amounts, address. Extract → assess → discard.      │
  └───────────────────────────────────────────────────────────────┘
                                      │
  ┌───────────────────────────────────────────────────────────────┐
  │ STAGE D — AUTHENTICATE (forensic signal generation)           │
  │ Runs the Part 1.1 technique set that is POSSIBLE on an image:  │
  │   font/kerning outliers, template/zoning deviation, metadata/  │
  │   EXIF anomalies, error-level/noise analysis, copy-move,       │
  │   composite-boundary, color-alignment, repeat-document hash.   │
  │ Output = a set of ASSISTANCE FLAGS + a tamper-risk score.      │
  │ This NEVER auto-rejects. It annotates for the human reviewer.  │
  │ 3D/physical-security checks: explicitly NOT possible → recorded│
  │ as a permanent coverage gap on every result.                  │
  └───────────────────────────────────────────────────────────────┘
                                      │
  ┌───────────────────────────────────────────────────────────────┐
  │ STAGE E — CROSS-REFERENCE (the part that gives it real weight) │
  │ Extracted fields are checked AGAINST authoritative/known data: │
  │   1. Institution: name → Institution Trust DB (IPEDS/HESA/ROR/ │
  │      Wikidata/School Cleaner). Real? accredited? domain match? │
  │   2. Claim-vs-document: does the document's name/institution/  │
  │      dates MATCH what the subscriber self-reported and what    │
  │      enrichment found? Mismatches = high-value flags.          │
  │   3. Enrollment dates vs stated_graduation_date consistency.   │
  │   4. (If/when available) the AUTHORITATIVE sources from the    │
  │      verification layer — a document is corroboration, the     │
  │      registrar/NSC is truth. Document never overrides an       │
  │      authoritative source.                                     │
  │   5. Country/issuer plausibility (does this institution issue  │
  │      this document type in this format/country?).              │
  │ Output = match/mismatch set feeding the verdict.               │
  └───────────────────────────────────────────────────────────────┘
                                      │
  ┌───────────────────────────────────────────────────────────────┐
  │ STAGE F — DECISION (human-in-the-loop, MEDIUM cap)            │
  │ • Machine produces: extracted fields + assistance flags +      │
  │   tamper score + cross-ref match set + a RECOMMENDATION        │
  │   (enrolled@medium / inconclusive / suspected-tamper).         │
  │ • A HUMAN REVIEWER makes the actual call in the review queue.  │
  │ • Max confidence assignable from a document = MEDIUM.          │
  │ • Result written to verification_results (enrolled/unable/     │
  │   not_enrolled) with method='document', confidence='medium'.   │
  │ • A 'not_enrolled' from a document STILL routes through the    │
  │   adverse-action gate (notice + appeal). Never auto-action.    │
  └───────────────────────────────────────────────────────────────┘
                                      │
  ┌───────────────────────────────────────────────────────────────┐
  │ STAGE G — PURGE                                                │
  │ • The instant the verdict is recorded, DELETE the raw file.    │
  │ • Store ONLY: extracted minimal fields needed for audit, the   │
  │   verdict, the flags (as booleans/enums, not the image),       │
  │   a perceptual hash (for repeat-document detection), and the   │
  │   reviewer decision. NEVER the raw document beyond the 24h     │
  │   processing window (hard ceiling; target deletion in minutes  │
  │   after verdict).                                              │
  └───────────────────────────────────────────────────────────────┘
```

---

## PART 3 — THE VISION/OCR CLIENT SEAM (What To Build Now vs Defer)

**Build now (dormant):** the `DocumentProvider` interface and a `makeDocumentProvider()` factory that returns a stub. The stub returns `outcome='pending_review'` / `enrolled@medium` / `unable` deterministically for tests — NO real OCR, NO SDK, NO API key.

```typescript
interface DocumentProvider {
  classify(fileRef: StorageRef): Promise<DocClassification>;   // type/issuer/country/lang
  extract(fileRef: StorageRef, template: DocTemplate): Promise<ExtractedFields>;
  authenticate(fileRef: StorageRef): Promise<ForensicFlags>;   // tamper score + flags
}
// makeDocumentProvider(): returns StubDocumentProvider until a real impl is injected.
```

**Defer (until gate opens + provider chosen):** the concrete implementation behind the seam. When chosen, the realistic options to evaluate (do NOT integrate now, just know the shape):
- A vision-LLM (e.g. Claude vision) for classify+extract on heterogeneous global documents — strong on never-before-seen layouts, which matters because Lycert has thousands of institutions and no per-issuer training data. Forensic/tamper analysis is NOT a vision-LLM strength.
- A dedicated document-forensics API (the Fortiro / G2 / Entrust class) for Stage D tamper analysis.
- The likely real architecture is BOTH: vision-LLM for extract, forensics API for authenticate. The seam must allow two different backends for extract vs authenticate.

Because the implementation is deferred, **the interface is the deliverable now.** Get the seam shape right so neither backend choice forces a rewrite.

---

## PART 4 — DATA MODEL (Build now, dormant)

### Migration `verification_0010_documents.sql`
```sql
CREATE TABLE verification_documents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id uuid REFERENCES subscribers(id) ON DELETE CASCADE,
    consent_id uuid REFERENCES verification_consents(id),   -- REQUIRED, document-specific consent
    -- NO raw file path stored long-term. This holds the transient ref only while processing.
    transient_storage_ref text,            -- private bucket key; nulled on purge
    storage_delete_at timestamptz NOT NULL, -- now()+24h HARD CEILING; target: minutes post-verdict
    purged_at timestamptz,                  -- when raw file was actually destroyed

    doc_type text,                          -- 'student_id'|'enrollment_cert'|'tuition_bill'|'unknown'
    issuer_institution text,                -- extracted, normalized
    issuer_country text,
    -- EXTRACTED MINIMAL FIELDS (no images, no IDs, no financial amounts)
    extracted_name text,
    extracted_institution text,
    extracted_enrollment_status text,
    extracted_enrollment_end date,
    extracted_doc_issue_date date,
    age_eligible boolean,                   -- boolean only; never store DOB

    -- FORENSIC OUTPUT (booleans/enums/score; never the image)
    tamper_risk_score numeric(4,3),         -- 0..1
    flag_font_anomaly boolean DEFAULT false,
    flag_template_deviation boolean DEFAULT false,
    flag_metadata_anomaly boolean DEFAULT false,
    flag_copy_move boolean DEFAULT false,
    flag_composite boolean DEFAULT false,
    flag_color_inconsistency boolean DEFAULT false,
    flag_repeat_document boolean DEFAULT false,   -- matched a prior submission's perceptual hash
    perceptual_hash text,                   -- for repeat-document detection across submissions
    physical_security_uncheckable boolean DEFAULT true,  -- ALWAYS true (image-only) — permanent gap

    -- CROSS-REFERENCE OUTPUT
    xref_institution_real boolean,
    xref_name_matches_claim boolean,
    xref_institution_matches_claim boolean,
    xref_dates_consistent boolean,

    -- DECISION
    machine_recommendation text,            -- 'enrolled_medium'|'inconclusive'|'suspected_tamper'
    reviewer_id uuid REFERENCES tenant_users(id),
    reviewer_decision text,                 -- 'approved'|'rejected'|'needs_more'
    reviewer_decided_at timestamptz,
    confidence text DEFAULT 'medium',       -- HARD CAP: never above 'medium' from a document
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE verification_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ver_docs_tenant" ON verification_documents
  FOR ALL TO authenticated USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);
```

Private storage bucket (Supabase Storage): encrypted, no public URLs, signed-URL access only for the assigned reviewer during the processing window, auto-delete policy enforced by a cron purge worker that also nulls `transient_storage_ref` and sets `purged_at`.

---

## PART 5 — GDPR / STORAGE (The Non-Negotiables, Verified)

Grounded in Art.5(1)(c) data minimization, Art.5(1)(e) storage limitation, Art.9 special-category, Art.25 privacy-by-design/default, Art.35 DPIA.

1. **Explicit consent (Art.9):** document upload requires explicit, specific, informed, freely-given, unambiguous consent, captured before the widget renders, separately recorded, and as easy to withdraw as to give. No consent row → no upload.
2. **Process-and-purge (industry standard):** extract → assess → derive verdict → destroy raw file. Target deletion within minutes of verdict; HARD ceiling 24h. Never the 30-day window used for enrichment — documents are more sensitive than enrichment fields.
3. **Store results, not images:** persist only the minimal extracted fields, boolean/enum flags, scores, perceptual hash, and reviewer decision. Never the photo, signature, national ID number, DOB (store only `age_eligible` boolean), financial amounts, or address.
4. **Encryption at rest + in transit; access controls:** private bucket, signed URLs scoped to the assigned reviewer only, full audit_log entry on every view/extract/purge.
5. **DPIA is MANDATORY (Art.35):** this is high-risk processing of special-category-adjacent data. A Data Protection Impact Assessment must be completed and signed off before the gate opens. This is a Part 9 prerequisite, not optional.
6. **EU AI Act note:** AI systems doing biometric identification are high-risk. Lycert's pipeline deliberately does NOT do biometric/face matching — it extracts text fields and checks document integrity. Keep it that way; do not add face-matching without a fresh high-risk assessment. Record `physical_security_uncheckable = true` always.
7. **Records of Processing (Art.30) + sub-processor registry:** any vision/forensics vendor chosen later is a special-category sub-processor — DPA, SCCs, SOC2/ISO27001 evidence required before wiring.
8. **Retention of the verdict:** the extracted-fields + verdict record follows the verification-layer retention (default 90d, per legal review) — the RAW DOCUMENT does not survive past processing.

---

## PART 6 — CONFIDENCE & SCORING INTEGRATION

- Document review writes to `verification_results` with `method_class='document'`, `confidence='medium'` (hard cap).
- In scoring (V1 authoritative signal, see verification doc Part 7): a document-derived `enrolled@medium` is weaker than NSC/HEDD authoritative and weaker than a live email-loop/SSO `control_proven`. Trust order: authoritative > semi-authoritative (email-loop/SSO) > **document (medium)** > enrichment (LinkedIn) > self-reported.
- A document can therefore *support* keeping a subscriber on EDU pricing, but a single document at MEDIUM should not, by itself, clear a subscriber whom authoritative signals contradict.
- `suspected_tamper` is NEVER an automatic adverse action. It elevates to human review and, if a reviewer confirms intent to defraud, routes through the full notice + appeal adverse-action gate like every other flag.

---

## PART 7 — REVIEW QUEUE UI (Defer build; specify shape now)

Per the advisor plan, defer the review-queue UI but make the backend operable via an approve/reject API now. When built, the reviewer screen must show: the extracted minimal fields, the assistance flags (as plain-language reasons, e.g. "font inconsistency detected in the date field"), the tamper score, the cross-reference match set, the machine recommendation, and approve/reject/needs-more controls with a mandatory decision note. The reviewer sees the document image via a time-boxed signed URL that expires when they decide or the processing window closes — and the image is never downloadable, only viewable.

---

## PART 8 — WHAT CLAUDE CODE MUST NOT DO
- Do not enable upload or accept a real document until Part 9 gate conditions are met.
- Do not wire a real OCR/vision SDK or API key now. Build the seam + stub only.
- Do not build auto-approval. Every document routes to a human at launch (no issuer training corpus exists).
- Do not store raw documents beyond the processing window (24h hard ceiling; target minutes).
- Do not extract or persist: photo, signature image, national ID number, full DOB, financial amounts, address.
- Do not let a document verdict exceed MEDIUM confidence.
- Do not let `suspected_tamper` or `not_enrolled` auto-action — always human + adverse-action gate.
- Do not add face/biometric matching (EU AI Act high-risk) without a separate assessment.
- Do not claim the pipeline detects physical security features — it cannot (image-only); record the gap every time.

---

## PART 9 — BUILD GATE & SEQUENCE

**Gate (ALL must be true before upload is enabled in any environment, incl. staging with real data):**
1. `LYCERT_DOC_REVIEW_ENABLED` flag = true (default false, per-environment).
2. Per-tenant legal sign-off flag set.
3. DPIA completed and signed off (Art.35).
4. Vision/forensics sub-processor(s) chosen, DPA/SCC/SOC2 on file, added to sub-processor registry.
5. Privacy Policy + consent text for document upload reviewed by counsel.

**Build now (dormant, behind gate):**
1. Migration `verification_0010_documents.sql`.
2. `DocumentProvider` interface + `makeDocumentProvider()` returning `StubDocumentProvider`.
3. The six-stage pipeline orchestration (A–G) running on the existing Supabase Queue (`verification_q`), with the vision calls going to the stub.
4. Private encrypted bucket + cron purge worker (enforces `storage_delete_at`, nulls ref, sets `purged_at`) — test the purge path hard, it's the most important safety mechanism.
5. Consent capture for document upload (Stage A), upload endpoint **gated OFF** by the flag.
6. approve/reject API (operable backend; UI deferred).
7. Cross-reference logic (Stage E) against the existing Institution Trust DB + subscriber claim + enrichment — this is pure logic, fully buildable now and testable with the stub.
8. Scoring integration (Part 6) as a dormant code path.

**Defer:** real vision/forensics backend wiring, review-queue UI, auto-approval (indefinitely).

**Test (with stub, before any push to staging):** consent-gates-upload, upload-blocked-when-flag-off, purge worker deletes on schedule + nulls ref, MEDIUM cap enforced, suspected_tamper never auto-actions, cross-reference mismatch flags fire correctly, perceptual-hash repeat-document detection, full audit_log on view/extract/purge.

## PART 10 — SOURCES (verified)
- DHS S&T (Jul 2025): image-based verification cannot assess physical security features — via ID Dataweb document-fraud analysis.
- Forgery technique/detection set: G2 Risk Solutions (500+ attributes, altered-image, issuer traits, 20-sample training), Fortiro (anomaly + investigation), iCOVER (structure/metadata/3D/color/typeface/zoning), Biometric Update (substituted fields/photos, masked blocks, composites, injected elements), Entrust/Onfido (repeat-document detection), arXiv 2403.00573 (scan-edit-print char-level + Delaunay layout descriptor), JETIR 2025 (CNN copy-move + signature, SVM).
- iProov (Sep 2025): injection-attack/deepfake tooling (flagged for future liveness only).
- GDPR storage/process-and-purge: Didit (DELETE-session, process-and-purge, modular minimal extraction), Art.5(1)(c)/(e), Art.9, Art.25, Art.35; EU AI Act high-risk biometric classification.

*End of LYCERT_DOCUMENT_REVIEW_ARCHITECTURE.md — Version 1.0*
