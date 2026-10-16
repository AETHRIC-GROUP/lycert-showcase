# LYCERT_VERIFICATION_ARCHITECTURE.md
**Version:** 1.0
**Date:** June 2026
**Status:** Authoritative specification for the ENROLLMENT VERIFICATION layer. This is a NEW, SEPARATE subsystem from enrichment. It does not replace or modify the V2/V3 enrichment waterfall — it sits beside it.
**For Claude Code:** Do NOT build this yet. This is the architectural specification for the verification layer that follows the current enrichment + scoring + queue consolidation work. Read it to understand the two-layer data model so nothing built now contradicts it. Build order and triggers are in Part 9.

> ⚠️ **PART 9 (build order) SUPERSEDED (2026-10-08) by `LYCERT_BRIDGE_ARCHITECTURE.md`.** The orchestrator,
> its asymmetry invariants (only `can_assert_not_enrolled=true` providers may assert not-enrolled), the
> consent gate, and the email-loop/document/NSC/HEDD code built under this spec all stay in place — Bridge
> Part 4.1 (KEEP) and 4.4 (FREEZE). But NSC/HEDD/document/email-loop are now **frozen, not actively pursued**
> (Bridge 4.4/4.5): no further registrar integrations, no email-loop activation. The layer's new
> authoritative source is **SheerID, orchestrated** (Bridge Part 7) — a `provider_orchestrated` adapter
> added to the SAME registry/orchestrator this doc defines, not a replacement of it.

---

## PART 0 — THE ONE IDEA THIS DOCUMENT EXISTS TO ENFORCE

**Lycert has two completely different data questions, and they must never be answered by the same source.**

| Question | Layer | Source class | Authority | Used for |
|---|---|---|---|---|
| "Who is this person professionally?" | **Enrichment** (V2/V3) | LinkedIn-derived (PDL, Findymail, Icypeas, FullEnrich, …) | **Indicative only** — self-reported, scraped, probabilistic | Scoring signals C1–C4; conversion targeting |
| "Is this person actually still enrolled?" | **Verification** (this doc) | Authoritative registrar / clearinghouse / email-loop / SSO / document | **Authoritative** — institution-confirmed or control-of-account proven | Compliance decisions; the lifecycle re-verification gate |

The enrichment layer tells you a subscriber's LinkedIn says they graduated and now work at Gensler. That is a **signal**, not proof. The verification layer tells you whether the University of Stuttgart's records (or the subscriber's continued control of a `@uni-stuttgart.de` inbox, or a clearinghouse) still show them as enrolled. That is **proof**.

A compliance decision that revokes or challenges a subscriber's EDU pricing must rest on the verification layer, never on enrichment alone. This is a legal requirement (defensibility of the adverse-action decision), not just a quality preference. Enrichment can *raise suspicion* and *prioritize* who to verify; only verification can *confirm* ineligibility.

---

## PART 1 — WHAT THE RESEARCH ESTABLISHED (Ground Truth, Verified)

These findings come from SheerID's own documentation and the National Student Clearinghouse's official pages. They define the boundaries of what is buildable.

### 1.1 The universal global student database does NOT exist
SheerID — the accuracy benchmark — explicitly operates with **no central database**. It is an **orchestration layer** over many point sources, with a waterfall: authoritative data source → SSO → email loop → document review. Its authoritative sources are **direct, bilateral integrations with individual registrars** (e.g. a university's Office of the Registrar), built over a decade, and deliberately kept secret as its moat. Conclusion: Lycert cannot buy or scrape its way to SheerID-level accuracy. Lycert must build the same *kind* of orchestration engine over the sources that are genuinely accessible.

### 1.2 SheerID is point-in-time; lifecycle re-check is the gap Lycert fills
SheerID verifies at a moment. Re-verification happens only when a *client* re-triggers it at renewal (confirmed via SheerID client SHRM's documentation: at renewal, status is re-checked and non-enrolled members are pushed to upgrade). Continuous lifecycle monitoring *between* those checks is exactly Lycert's differentiator. This document is how Lycert answers "still enrolled?" on an ongoing cadence.

### 1.3 The one authoritative source Lycert can access today: US National Student Clearinghouse (NSC)
NSC covers **3,600+ institutions ≈ 97–98% of US postsecondary enrollment**. Its **EnrollmentVerify** product confirms current enrollment; **DegreeVerify** confirms degrees/attendance. It offers an **integrated Web services (API) option for high-volume requestors**, 24/7, with volume discounts. **It is consent-gated and FERPA-governed**: without the student's signed/dated consent, a verification request returns **"Unable to Confirm"** (NSC does not use PII for Verification Services absent consent). This is the single highest-value authoritative integration available and is built first.

### 1.4 Outside the US, it is fragmented — integrate where accessible, fall back otherwise
No global NSC. National equivalents vary from "accessible API" to "registrar phone call." Lycert integrates national clearinghouses where they exist AND are accessible (US first, UK next), and everywhere else falls back to email-loop / SSO / document review — exactly SheerID's degradation pattern.

### 1.5 Institution identity data (not enrollment) is free and open
IPEDS (US), HESA (UK), Wikidata, ROR, OpenAlex, and the GitHub world-universities-and-domains list provide institution names, accreditation, and email domains — free, bulk/API. This is *institution* data, not *person* enrollment. It underpins email-domain validation and the Institution Trust DB, and it is the cheap durable foundation.

---

## PART 2 — THE VERIFICATION WATERFALL (Mirrors SheerID's Engine)

Per subscriber, attempted in this order. Stop at the first AUTHORITATIVE confirmation. Each method's result is written to a new `verification_results` table (Part 5) with its method and confidence.

```
INPUT: subscriber (email, name, institution_name, stated_graduation_date, country)
        + consent_status (REQUIRED before any authoritative lookup — Part 6)

STEP 1 — INSTITUTION RESOLUTION (free, internal)
  Resolve institution_name → canonical institution via Institution Trust DB
  (IPEDS/HESA/Wikidata/ROR + PDL School Cleaner). Get: country, accreditation,
  known email domains, NSC-participating? (US), SSO-capable?
  → determines which downstream methods are even possible.

STEP 2 — AUTHORITATIVE DATA SOURCE (the gold standard, region-dependent)
  IF country = US AND institution participates in NSC AND consent on file:
     → NSC EnrollmentVerify (API).  Result: ENROLLED / NOT_ENROLLED / UNABLE_TO_CONFIRM.
  ELSE IF country = UK AND HEDD-accessible AND consent:
     → HEDD degree/enrolment check.
  ELSE IF other national clearinghouse integrated (Part 4 expansion):
     → that source.
  ELSE: skip to Step 3.
  A definitive ENROLLED or NOT_ENROLLED here is AUTHORITATIVE → stop.

STEP 3 — SSO / INSTITUTIONAL LOGIN (authoritative, when supported)
  IF institution supports SSO (SAML/OIDC/Shibboleth/Google-Workspace-edu):
     → prompt subscriber to authenticate with their institution.
     A successful login proves CURRENT institutional membership → AUTHORITATIVE → stop.
  (Highest friction to build broadly; gold standard when present. Phase 3 of build.)

STEP 4 — EMAIL LOOP (semi-authoritative, high value, low cost)
  IF subscriber has (or provides) an email on a verified institutional domain:
     → confirm the email domain maps to the resolved institution (Institution Trust DB),
       then send a one-time verification link to that address.
     Clicking the link proves CURRENT control of an institutional inbox.
     This is a strong live-enrollment signal (most institutions disable email on
     graduation/withdrawal within months) → SEMI-AUTHORITATIVE → stop on success.
  NOTE: alumni-retained addresses are the known false-positive; weight accordingly
  (Part 7). Personal/Gmail addresses cannot use this method → skip.

STEP 5 — DOCUMENT REVIEW (fallback, first-time-verification feature reused)
  Prompt for enrollment certificate / student ID / tuition bill.
  OCR + field extraction + authenticity signals (reuse the planned first-time-
  verification document pipeline). Human-in-the-loop for borderline cases.
  Result confidence: MEDIUM (documents can be stale or forged) → record + flag.

EXHAUSTED: verification_status = UNVERIFIED.  Do NOT treat "unverified" as
"ineligible" — it means "could not confirm," which routes to human review, never
to automated adverse action.
```

### 2.1 Critical asymmetry rule
- A method returning **ENROLLED / control-proven** → subscriber stays on EDU; reset lifecycle clock. High confidence.
- A method returning **NOT_ENROLLED** (only authoritative sources can assert this — NSC/HEDD/SSO) → strong basis for the compliance workflow, but STILL passes through the human-in-the-loop adverse-action gate (notice + appeal) before any pricing change.
- **UNABLE_TO_CONFIRM / no-match / no-method-available** → NEVER an adverse signal on its own. Absence of confirmation is not evidence of ineligibility. Routes to human review or to the enrichment-based suspicion score for prioritization only.

This asymmetry is the legal backbone of the whole layer. Encode it explicitly; do not let "we couldn't verify" silently become "they're violating."

---

## PART 3 — STEP 2 PRIMARY SOURCE: NSC ENROLLMENTVERIFY (US) — DETAILED

**Status:** First authoritative integration to build. US-only, but covers a large share of the design-partner population.
**What it answers:** Is this person currently enrolled at a US postsecondary institution? (EnrollmentVerify) / Did they earn a degree / attend? (DegreeVerify).
**Coverage:** 3,600+ institutions, ~97–98% of US postsecondary enrollment.
**Access model:** NSC offers an **integrated Web services (API) option for high-volume requestors** in addition to the manual portal (enrollmentverify.org / degreeverify.org). Lycert pursues the Web services integration.
**Cost:** Per-verification fee, volume discounts available. Exact pricing is by commercial agreement with NSC — obtain a quote during onboarding (Part 9 prerequisites). Treat as a per-check paid authoritative source, budgeted like a premium enrichment call but used far more selectively.
**Latency:** Most requests instant; some 24–48h depending on institution's data-exchange participation.
**Freshness:** Enrollment data is institution-reported on each term's reporting schedule; current-term enrollment is generally reliable, with the known lag that a just-started or just-ended term may not be reflected for a few weeks. Degree verification for the most recent term can lag ~8 weeks (institution-dependent).

### 3.1 THE HARD CONSTRAINT — CONSENT (FERPA)
NSC will NOT return a student's enrollment/degree data to a third party without the **student's signed, dated consent** specifying the records, purpose, and recipient. Without it, the response is **"Unable to Confirm."** This is non-negotiable and shapes the product:
- Lycert must capture explicit, FERPA-valid consent from the subscriber BEFORE running an NSC check.
- Consent is captured at the point the subscriber interacts with Lycert's hosted verification/re-verification flow (the subscriber consents to "verify my current enrollment status with my institution / the National Student Clearinghouse for the purpose of confirming continued eligibility for [Client]'s student program").
- Consent is stored, timestamped, scoped, and revocable (Part 6). No consent → NSC step is skipped, not failed.
- This means NSC verification is **subscriber-initiated or subscriber-consented**, not a silent background lookup. It fits the re-verification flow (where the subscriber is already engaged) far better than silent monitoring.

### 3.2 Integration shape (confirm exact schema with NSC during onboarding)
```
NSC Web Services (integrated option) — REST/secure exchange, OAuth-class auth,
TLS in transit. Exact endpoint paths, auth, and request/response schema are
provided by NSC under the Web Services agreement — DO NOT invent them; they are
not fully public. The integration contract is obtained when the NSC commercial
agreement is signed.

Conceptual request:  { first_name, last_name, date_of_birth (if required),
                       institution (optional — NSC matches nationally),
                       consent_reference }
Conceptual response: { status: ENROLLED | NOT_ENROLLED | UNABLE_TO_CONFIRM,
                       enrollment_begin, enrollment_end, enrollment_status
                       (full-time/half-time/etc.), as_of_date }
```
**Implementation rule:** the NSC client lives behind Lycert's own `VerificationProvider` interface (Part 5) exactly as enrichment providers live behind `EnrichmentProvider`. NSC is one provider among several; the waterfall is provider-agnostic.

### 3.3 NSC "Sentinel" note
NSC also markets enrollment-intelligence products (e.g. fraud/"ghost student" detection). These are institution-side products, not Lycert's use case. Lycert uses Verification Services (EnrollmentVerify/DegreeVerify) only. Do not conflate.

---

## PART 4 — STEP 2 EXPANSION: NON-US AUTHORITATIVE SOURCES (Roadmap, Not Day 1)

Build these in priority order, each behind the same `VerificationProvider` interface. Each requires its own commercial/data agreement and its own consent/legal review. NONE are assumed accessible until an agreement is in hand — flag, don't assume.

| Region | Source | Type | Accessibility (verify at integration time) | Priority |
|---|---|---|---|---|
| **US** | National Student Clearinghouse | Enrollment + degree | API (Web services), consent-gated, paid | 1 (build first) |
| **UK** | HEDD (Higher Education Degree Datacheck, Jisc/Prospects) | Degree + enrolment | Paid, consent-based, per-check | 2 |
| **India** | NAD / DigiLocker (govt academic records) | Academic records | Govt API, gated, consent-based | 3 (large population) |
| **Germany** | Per-Hochschule registrar (no national feed) | Enrollment | Manual / per-institution; some SSO | Fallback via Steps 3–5 |
| **EU (various)** | Per-institution registrar / national agencies (e.g. country ministries of education) | Enrollment | Highly variable; mostly per-institution | Fallback via Steps 3–5 |
| **Rest of world** | Per-institution registrar | Enrollment | Mostly manual / SSO / email-loop / docs | Fallback via Steps 3–5 |

**The honest expansion principle:** outside US/UK, "authoritative API" mostly does not exist. The realistic path for most of the world is Steps 3–5 (SSO where possible, email-loop, document review) plus the free Institution Trust DB. This is exactly why SheerID's international coverage degrades — and why Lycert's will too, until per-country agreements are built one at a time. Set client expectations accordingly: authoritative enrollment confirmation is strong in US/UK, semi-authoritative (email-loop/SSO) elsewhere, document-based in the long tail.

---

## PART 5 — DATA MODEL (New Tables, Additive)

### Migration `verification_0001_providers.sql`
```sql
CREATE TABLE verification_providers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_key text UNIQUE NOT NULL,   -- 'nsc','hedd','sso','email_loop','document','digilocker'
    display_name text NOT NULL,
    method_class text NOT NULL,          -- 'authoritative' | 'semi_authoritative' | 'document'
    country_scope text[],                -- ISO codes this provider covers; NULL = global (email_loop, document)
    requires_consent boolean NOT NULL DEFAULT true,
    can_assert_not_enrolled boolean NOT NULL DEFAULT false,  -- only true for NSC/HEDD/SSO
    enabled boolean NOT NULL DEFAULT false,
    default_position integer,
    cost_per_check_usd numeric(8,4),
    notes text
);
-- Seed: nsc(authoritative, [US], can_assert_not_enrolled=true),
--       hedd(authoritative,[GB],true, enabled=false),
--       sso(authoritative, NULL, true, enabled=false),
--       email_loop(semi_authoritative, NULL, can_assert_not_enrolled=false),
--       document(document, NULL, false).
```

### Migration `verification_0002_results.sql`
```sql
CREATE TABLE verification_results (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id uuid REFERENCES subscribers(id) ON DELETE CASCADE,
    provider_key text REFERENCES verification_providers(provider_key),
    method_class text NOT NULL,          -- snapshot at time of check
    status text NOT NULL,                -- 'enrolled'|'not_enrolled'|'unable_to_confirm'|'control_proven'|'document_pending'|'error'
    confidence text NOT NULL,            -- 'authoritative'|'semi_authoritative'|'medium'|'low'
    enrollment_status text,              -- full-time/half-time/etc. when provided
    enrollment_end_date date,            -- when source provides it
    as_of_date date,                     -- the date the source's data is current to
    consent_id uuid,                     -- FK → verification_consents (Part 6)
    raw_reference text,                  -- provider's request id; NO raw PII payload stored
    checked_at timestamptz NOT NULL DEFAULT now(),
    delete_at timestamptz                -- retention per Part 6
);
ALTER TABLE verification_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ver_results_tenant" ON verification_results
    FOR ALL TO authenticated USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);
```

### Migration `verification_0003_subscriber_status.sql`
```sql
-- Authoritative enrollment status on the subscriber, distinct from enrichment-derived signals
ALTER TABLE subscribers ADD COLUMN verification_status text DEFAULT 'unverified';
  -- 'verified_enrolled' | 'verified_not_enrolled' | 'unverified' | 'verification_expired'
ALTER TABLE subscribers ADD COLUMN verification_method text;        -- which method last confirmed
ALTER TABLE subscribers ADD COLUMN verification_confidence text;    -- authoritative/semi/medium
ALTER TABLE subscribers ADD COLUMN verified_at timestamptz;
ALTER TABLE subscribers ADD COLUMN verification_expires_at timestamptz;  -- re-verify cadence anchor
```

### The `VerificationProvider` interface (mirrors enrichment `base.py`)
```python
class VerificationOutcome(str, Enum):
    ENROLLED = "enrolled"
    NOT_ENROLLED = "not_enrolled"          # only authoritative providers may return this
    CONTROL_PROVEN = "control_proven"      # email-loop / SSO success
    UNABLE_TO_CONFIRM = "unable_to_confirm"
    DOCUMENT_PENDING = "document_pending"
    ERROR = "error"

class VerificationProvider(ABC):
    provider_key: str
    method_class: str           # authoritative | semi_authoritative | document
    requires_consent: bool
    @abstractmethod
    async def verify(self, subscriber, consent) -> VerificationResult: ...
```

---

## PART 6 — CONSENT, FERPA, GDPR (The Legal Spine)

This layer touches the most sensitive data in the product (authoritative education records). The constraints below are mandatory and shape the UX.

### 6.1 Consent capture (`verification_consents` table)
```sql
CREATE TABLE verification_consents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id uuid REFERENCES subscribers(id) ON DELETE CASCADE,
    scope text NOT NULL,            -- what records, e.g. 'enrollment_status'
    purpose text NOT NULL,          -- 'continued EDU eligibility verification for {client}'
    recipient text NOT NULL,        -- 'National Student Clearinghouse' / institution
    consent_text_version text NOT NULL,
    granted_at timestamptz NOT NULL,
    granted_via text,               -- 'hosted_verification_flow'
    ip_address text,
    revoked_at timestamptz,         -- consent is revocable
    expires_at timestamptz
);
```
- FERPA requires consent to be **signed (electronic OK), dated, scoped, purpose-stated, recipient-identified.** The hosted flow's consent screen must capture all five and store the exact consent text version.
- No authoritative check (`requires_consent=true`) runs without an active, unexpired, unrevoked consent row. Enforce in code, not just UI.
- GDPR: the lawful basis for verification processing is the subscriber's **consent** here (stronger and cleaner than the legitimate-interest basis used for enrichment). Education records may constitute sensitive processing in some jurisdictions — the consent basis covers this. Document in the LIA/ROPA.

### 6.2 Data minimisation & retention
- Store the **result** (enrolled/not/confidence/as_of_date), NOT the underlying record payload. No transcripts, no GPA, no course lists — Lycert never needs them and must not store them.
- `verification_results.raw_reference` holds only the provider's request id, never the returned PII body.
- Retention: verification results retained only as long as needed for the compliance decision + appeal window, then deleted (set `delete_at`). Align with the enrichment 30-day discipline; authoritative results may justify a slightly longer audit window — set per legal review, default 90 days.

### 6.3 The adverse-action gate (unchanged principle, reaffirmed)
A `verified_not_enrolled` result is the strongest signal Lycert can produce — and it STILL goes through notice + human review + appeal before any pricing change, exactly like every other compliance flag. Authoritative data raises confidence; it does not remove the human gate.

---

## PART 7 — HOW VERIFICATION AND ENRICHMENT COMBINE IN SCORING

The scoring engine (CEDS/TS) gains an authoritative input that **outranks** enrichment signals.

- **New top-priority signal `V1` (authoritative enrollment):**
  - `verification_status = verified_enrolled` (authoritative/semi) → strong EXCULPATORY, overrides enrichment-based suspicion. A LinkedIn-says-graduated signal (C3) is overruled by an NSC-says-enrolled result. Encode: when V1 = enrolled, cap total suspicion score below the Tier-2 threshold.
  - `verification_status = verified_not_enrolled` (authoritative only) → strong INCULPATORY, but routes to human review (never auto-action).
  - `unverified` → V1 contributes 0. Enrichment signals carry the score as today. (Absence of verification is not evidence.)
- **Trust ordering:** authoritative verification > semi-authoritative (email-loop/SSO) > enrichment (LinkedIn-derived) > self-reported. The scorer applies this strictly: a higher-authority source always overrides a lower one on the enrollment question.
- **Enrichment's role narrows to its proper job:** prioritization. Enrichment suspicion decides WHO to spend an authoritative verification check on (NSC costs money; don't check everyone). High enrichment-suspicion + US institution + consent → run NSC. This is the cost-control bridge between the two layers.

---

## PART 8 — EMAIL LOOP & SSO DETAIL (The Globally-Applicable Methods)

Because authoritative APIs only exist in a few countries, Steps 3–4 carry most of the international load. Build them to be excellent.

### 8.1 Email loop (Step 4) — build early, high ROI
- Resolve subscriber's email domain against Institution Trust DB → must map to the claimed institution.
- Send a one-time, expiring, single-use verification link (reuse Resend infra) to the institutional address.
- Click within window → `control_proven`, confidence `semi_authoritative`.
- **False-positive control:** many institutions keep alumni email alive. Mitigate by (a) treating email-loop as semi- not fully-authoritative, (b) combining with stated_graduation_date (if graduation is years past AND only email-loop passes, keep elevated review), (c) preferring an authoritative source when available.
- Personal/Gmail subscribers cannot use this method → waterfall continues to documents.

### 8.2 SSO (Step 3) — gold standard, build later
- Where an institution supports SAML/OIDC/Shibboleth (or Google Workspace for Education), a successful institutional login proves current membership.
- Highest authority of the friction-based methods; also the hardest to scale (per-IdP). Build after NSC + email-loop, targeting the highest-volume institutions in the client's subscriber base first.

---

## PART 9 — BUILD ORDER, PREREQUISITES, TRIGGERS

### 9.1 Do NOT build until these prerequisites are met (Joshua's actions)
1. NSC commercial agreement initiated → obtain Web Services integration contract, exact API schema, and per-check pricing. (Nothing about NSC's exact endpoints is public; the schema comes with the agreement.)
2. Legal review of the FERPA consent text + GDPR consent basis for verification (separate from the enrichment LIA). Budget lawyer time.
3. Confirm the enrichment + scoring + queue consolidation (ENGINE_CONSOLIDATION_PLAN REV 2) is complete and stable. Verification rides the SAME Supabase Queue infrastructure — do not build it on anything else.

### 9.2 Build sequence (after prerequisites)
1. Schema: `verification_providers`, `verification_results`, `verification_consents`, subscriber status columns.
2. `VerificationProvider` interface + the verification waterfall orchestrator (mirror the enrichment cascade; runs on the existing queue, separate `verification_q`).
3. Consent capture in the hosted re-verification flow (the five FERPA fields).
4. Email-loop provider (Step 4) — globally applicable, no external agreement needed, highest ROI first build.
5. Institution resolution wiring (reuse Institution Trust DB / School Cleaner).
6. NSC EnrollmentVerify provider (Step 2, US) once the agreement + schema are in hand.
7. Document-review provider (Step 5) — reuse the first-time-verification OCR pipeline when that is built.
8. Scoring integration: add V1 authoritative signal with override semantics (Part 7).
9. SSO provider (Step 3) — later, highest-volume institutions first.
10. International expansion (HEDD, DigiLocker, …) — each its own agreement + provider, one at a time.

### 9.3 Triggers (when verification runs)
- **Re-verification cadence:** the lifecycle engine, at the re-verification points (T-90/T-30/T-0/T+30 around stated graduation, and at renewal), enqueues a verification job for the subscriber — consent permitting.
- **High-suspicion enrichment result:** when enrichment pushes a subscriber to Tier 1/2 AND an authoritative source is available for their country AND consent exists, enqueue an NSC/HEDD check to confirm before any human review.
- **Subscriber-initiated:** the subscriber completes the hosted re-verification flow (email-loop/SSO/consent for NSC) themselves — the cleanest, highest-consent path.
- Never run a consent-required authoritative check without an active consent row. Ever.

---

## PART 10 — WHAT CLAUDE CODE MUST NOT DO
- Do not treat enrichment (LinkedIn-derived) data as proof of (non-)enrollment. It is signal only.
- Do not let `unable_to_confirm` / `unverified` become an adverse signal — absence of confirmation is not evidence of ineligibility.
- Do not run NSC (or any `requires_consent` provider) without an active, scoped, unexpired consent row — enforce in code.
- Do not store the underlying education-record payload (transcripts, GPA, courses). Store only the result + confidence + as_of_date.
- Do not invent NSC endpoint paths/schema — they come with the commercial agreement; stub the provider behind the interface until the contract is in hand.
- Do not build this layer on any runtime other than the consolidated Supabase Queue infrastructure.
- Do not let any `not_enrolled` result trigger an automated pricing change — it always passes the human-in-the-loop adverse-action gate.

## PART 11 — SOURCES (official, verified)
- SheerID verification engine (waterfall: authoritative → SSO → email loop → document): sheerid.zendesk.com / developer.sheerid.com
- SheerID "no central database," authoritative sources secret: SheerID FAQ + developer center
- NSC EnrollmentVerify / DegreeVerify, coverage 97–98%, Web services API, volume pricing: studentclearinghouse.org/verify, /solutions/business-verifications
- NSC FERPA consent requirement / "Unable to Confirm" without consent: studentclearinghouse.org Privacy Policy, Privacy Block Setting help, Verification Services FAQs
- Institution identity data: IPEDS, HESA, Wikidata, ROR, OpenAlex, GitHub world-universities-and-domains

*End of LYCERT_VERIFICATION_ARCHITECTURE.md — Version 1.0*
