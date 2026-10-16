# LYCERT_WATERFALL_ENRICHMENT_V3.md
**Version:** 3.0
**Date:** June 2026
**Status:** Authoritative. EXTENDS LYCERT_WATERFALL_ENRICHMENT_V2.md. Adds three new sync providers (Findymail, Icypeas, Dropcontact) and documents the Clay-via-webhook async path as a future Enterprise option. Everything in V2 (the cascade engine, merge rules, provider registry, field provenance, GDPR field exclusions, 30-day deletion, enrichment_jobs) remains in force.
**For Claude Code:** This is an EXTENSION. The provider registry, `providers/base.py` interface, orchestrator cascade, and merge engine already exist from V2. You are adding new provider clients that implement the existing `EnrichmentProvider` interface, plus three new registry rows and updated default positions. Do NOT rewrite the cascade. Check the repo's current `providers/` directory and registry seed before writing.

> ⚠️ **SUPERSEDED (2026-10-08) by `LYCERT_BRIDGE_ARCHITECTURE.md` Part 4.4.** Findymail/Icypeas/Dropcontact
> measured 0/5 useful on the benchmark and are now **frozen** (`enrichment_providers.enabled=false` on
> staging, applied 2026-10-08) — not paused pending a keep/drop decision, but parked for deletion in a
> cleanup PR after Bridge Milestone M5 unless Joshua says otherwise. Code/tests/migrations 0035–0036 stay
> in the repo. Do not re-enable or extend V3 without a new decision.

---

## PART 0 — WHY V3, AND WHAT THE BENCHMARK TOLD US

### 0.1 The measured problem (from PROVIDER_RESEARCH_REPORT.md)
On the 5-subscriber design-partner ground-truth spot-check, the V2 stack resolved ~3/5. PDL (2/5) and FullEnrich (1/5) carried it; Hunter and Datagma contributed 0/5 on this population. The two unresolved subscribers were **international + personal/academic** (Malta `.edu.mt`, Brazil hotmail) — both confirmed on LinkedIn by Clay, so the data exists; we lacked reach. Datagma was confirmed to **refuse personal/edu domains outright** (400 "This email is not accepted"). ReverseContact was **untestable** (trial blocks live enrichment) and stays disabled.

### 0.2 The fix
Add three providers that all (a) have genuinely testable free tiers allowing real enrichment calls, and (b) are EU/GDPR-native, improving both coverage on our international population and our sub-processor posture:
- **Findymail** — sync reverse-email→profile, instant free API key, EU
- **Icypeas** — async reverse lookup, 50 free no-card credits, cheapest at scale, EU
- **Dropcontact** — highest accuracy / lowest error rate in independent benchmark, EU — but a NAME→email finder, not a reverse-email tool (role clarified in 1.3)

And document, for a **future Enterprise step only**, the **Clay-via-webhook** async path (same pattern as FullEnrich), since Clay is the aggregator that produced our ground truth.

### 0.3 What does NOT change
- The V2 cascade engine, `classify_completeness`, all 6 merge rules, field provenance, the async webhook receiver pattern, the priority-≥-40 async-sweep gate.
- The scoring engine (provider-agnostic).
- GDPR field exclusions (no gender/birth/phone/salary), 30-day raw deletion, charge-on-match accounting.
- ZeroBounce Stage-0 gate. PDL position. Apollo disabled. Datagma — now demoted (see Part 4).

### 0.4 One correction carried into V3 (accuracy note)
The "FullEnrich 96%" figure in earlier notes came from a vendor (Icypeas) blog. The largest **independent** benchmark (Dropcontact's 20,000-contact study) put FullEnrich at **48.3% effective rate with a 15.3% error rate and 11.7% wrong-domain rate**. FullEnrich stays in the cascade as the async aggregator sweep, but its high error rate means **merge rule #4 (wrong-person guard) is load-bearing** — keep it strict, and treat FullEnrich employment data as lower-trust than a sync specialist's when merging.

---

## PART 1 — NEW PROVIDER REFERENCE (Verified Against Official Docs)

Each implements the existing `EnrichmentProvider` ABC from V2 `providers/base.py`. Source for every contract below is the provider's own API documentation (URLs in Part 9).

---

### 1.1 Findymail — Reverse Email Lookup (SYNC, EU) — NEW WATERFALL STEP 2

**Role in Lycert:** Primary personal-email→LinkedIn-profile resolver. Synchronous (no webhook needed), which makes it simpler than FullEnrich and ideal as an early cascade step. French company, GDPR/DPA published.
**Modality fit:** Exactly right — dedicated reverse-email→profile endpoint.
**Auth:** `Authorization: Bearer {LYCERT_FINDYMAIL_API_KEY}`. API key issued instantly on free signup, no credit card.
**Execution mode:** `sync`.
**Rate limit:** 300 concurrent requests by default (generous — no token bucket needed, but cap our concurrency at a sane number, e.g. 20, to be polite and predictable).
**Pricing / accounting:** Reverse lookup **uses 1 credit without profile data, 2 credits WITH full profile enrichment**. We always request the profile (`with_profile: true`) because Lycert needs employment/education — so budget **2 credits per successful reverse lookup**. Charge-on-success model (no charge when nothing is found). Pay-as-you-go; effective cost depends on plan tier.

```
POST https://app.findymail.com/api/search/reverse-email
Headers:
  Authorization: Bearer {LYCERT_FINDYMAIL_API_KEY}
  Content-Type: application/json
Body:
  {
    "email": "subscriber@example.com",
    "with_profile": true          ← REQUIRED for Lycert (we need title/company/profile)
  }

Response 200 (match):
  {
    "fullName": "John Doe",
    "headline": "CEO at Example",
    "jobTitle": "CEO",
    "companyName": "Example Inc"
  }
  (with_profile=true returns the fuller profile object — confirm the exact extended
   field set against app.findymail.com/docs at implementation time; the doc page
   shows the core four, the profile-enriched response adds LinkedIn URL + company
   detail. Map whatever the live response contains; record data_gaps for absences.)
```

**Field mapping (Findymail → subscriber_enrichment):**
| Findymail field | Column | Note |
|---|---|---|
| `fullName` | (used only for wrong-person guard, not stored as enrichment) | |
| `jobTitle` | `li_job_title` | |
| `headline` | (fallback for `li_job_title` if jobTitle absent) | |
| `companyName` | `li_current_employer_name` | |
| LinkedIn URL (in profile-enriched response) | `linkedin_profile_url` | confirm exact key at impl time |
| company domain (if present) | `li_current_employer_domain` | |

**What Findymail does NOT reliably return:** education history and employment start/end dates are not in the documented core response. Treat Findymail as **PARTIAL by default** for Lycert's purposes (it satisfies C1/C2/C4 but typically not C3 or employment dates) → it keeps the cascade going so a later provider can fill education. If the profile-enriched payload does include education/dates at implementation time, map them and let it score COMPLETE.

**Graceful skip / errors:** On 404/empty → MISS, continue cascade, no charge. On 401 → provider misconfigured, log and skip provider for the whole job (don't fail the subscriber). On 429 → backoff and retry once, then skip.

---

### 1.2 Icypeas — Reverse Email Lookup (ASYNC, EU) — NEW WATERFALL STEP 3

**Role in Lycert:** Cheapest reverse-lookup specialist; EU; GDPR/CCPA/ISO 27001 certified, open-source-intelligence only (no scraped private data — a genuine compliance plus). Returns a full professional profile incl. LinkedIn + company + seniority.
**Auth:** `Authorization: {LYCERT_ICYPEAS_API_KEY}` header (NOTE: Icypeas docs show the raw key in the `Authorization` header, and there is ALSO a request-signature scheme documented under "API authorization" — confirm whether the signature is mandatory for production at implementation time; the getting-started example uses the bare key).
**Execution mode:** `async` — but a **poll-based async**, not webhook. This is different from FullEnrich. You POST a search, get back an `_id` with `status: "NONE"`, then poll a result route until status becomes terminal. Icypeas also supports a `webhookUrl` in `userData` for notification, but the documented baseline flow is submit→poll.
**Rate limit:** 30 requests/minute (per Cargo's integration doc). Enforce a token bucket at 30/min.
**Pricing / accounting:** **Reverse lookup costs 10 credits per lookup** (email *finding* is 1 credit, *verification* 0.1 — but the reverse-email→profile feature is the expensive one at 10). 50 free no-card credits on signup = only ~5 reverse lookups for free, so **the free tier is enough to BENCHMARK accuracy on a handful of the design-partner sample but not to run volume**. Credits roll over, never expire. Plans start ~$19/1,000 credits. At 10 credits/reverse lookup that's ~$0.19 per reverse lookup at the entry tier — more than Findymail; cheaper at higher tiers.

```
SUBMIT:
POST https://app.icypeas.com/api/email-search        ← confirm the exact reverse-lookup
                                                        route name at impl time; getting-started
                                                        shows email-search for find, there is a
                                                        distinct reverse-lookup route — verify
                                                        against api-doc.icypeas.com
Headers:
  Authorization: {LYCERT_ICYPEAS_API_KEY}
  Content-Type: application/json
Body (reverse lookup takes the email):
  { "email": "subscriber@example.com",
    "userData": { "webhookUrl": "", "externalId": "lycert_subscriber_uuid" } }

→ 200:
  { "success": true, "item": { "status": "NONE", "_id": "p_xxx" } }

POLL:
POST https://app.icypeas.com/api/bulk-single
Headers: Authorization: {key}, Content-Type: application/json
Body: { "id": "p_xxx" }

→ 200 (terminal):
  { "success": true, "items": [ {
      "results": {
        "firstname": "...", "lastname": "...", "fullname": "...",
        "emails": [ ... ],
        ...profile fields: job title, company, seniority, LinkedIn (per reverse-lookup result schema)...
      },
      "status": "DEBITED",        ← terminal SUCCESS (credit charged, data found)
      "userData": { "externalId": "lycert_subscriber_uuid" },
      "_id": "..."
  } ], "total": 1 }

Status values: "NONE"/"SCHEDULED"/"IN_PROGRESS" = keep polling;
               "DEBITED" = success (charged);
               "FREE"/"NONE"-terminal/"NOT_FOUND" = no match (confirm exact no-match status
               string against api-doc at impl time);
               "FAILED" = error.
```

**Async handling in Lycert:** Icypeas is poll-based, so wire it like FullEnrich's pending state BUT with a poller instead of a webhook receiver: on submit, write `pending_async_provider='icypeas'` + store the `_id`; a Supabase cron worker polls `bulk-single` for pending Icypeas IDs every N seconds (respect 30/min), and on terminal status merges the result and clears pending. Reuse the V2 24h stale-pending cleanup. Pass `externalId = subscriber_id` so results map back without ambiguity.

**Field mapping:** results object → standard `_map_linkedin_style_profile()` helper (same as ReverseContact/Datagma in V2). Education coverage is profile-dependent; map what's present, record data_gaps otherwise. The `emails` array is NOT stored (GDPR — we already have the email; we don't store provider-returned alternate emails).

**Graceful skip / errors:** Because reverse lookups cost 10 credits each, Icypeas should be **gated to higher-priority subscribers** even within the cascade — only call Icypeas when the merged record is still not COMPLETE after Findymail AND the subscriber's `enrichment_priority >= 40` (same threshold as the async sweep). For low-priority subscribers, skip Icypeas to conserve the expensive credits. Document this as an Icypeas-specific gate in the registry (`min_priority` column, Part 3).

---

### 1.3 Dropcontact — Name+Company → Email/Profile (ASYNC batch, EU) — NEW WATERFALL STEP 4 (CONDITIONAL)

**Role in Lycert — READ CAREFULLY, this is NOT a reverse-email tool.** Dropcontact's core is **find/verify a professional email and enrich a contact from name + company**, and clean/dedupe data. It is the **#1 accuracy / lowest-error provider** in the independent 20k benchmark (54.9% effective, 1.9% error, 0.9% bounce) and is the strongest EU/GDPR option. But its input modality is name+company, not a raw personal email. **It only helps Lycert for subscribers where we already have a name AND some company/domain signal** (e.g. from a prior partial provider hit, or from the subscriber's own submitted data). For a bare personal email with no name/company, Dropcontact is the wrong tool — skip it.
**Auth:** `X-Access-Token: {LYCERT_DROPCONTACT_API_KEY}` header.
**Execution mode:** `async` batch — POST returns a `request_id`, then GET the batch result by id (poll). Same poll pattern as Icypeas.
**Rate limit:** 60 requests/minute.
**Pricing / accounting:** **Pay-on-success: 1 credit = 1 email found or verified; if no email is found, the credit is refunded.** HOWEVER, an important real-world caveat from user reports: on difficult/non-EU files, 15–20% of credits can be consumed without a result, and **performance drops outside Europe (≈62% US vs ≈94% France)**. So Dropcontact is strongest for our EU subscribers, weakest for US ones. Plans from ~€29/500 credits (Starter); Growth tier adds **LinkedIn enrichment + company data + credit carryover**. NOTE: LinkedIn enrichment is a **Growth-plan** feature — confirm the plan tier before relying on it for `linkedin_profile_url`.

```
SUBMIT (batch):
POST https://api.dropcontact.io/batch
Headers:
  X-Access-Token: {LYCERT_DROPCONTACT_API_KEY}
  Content-Type: application/json
Body:
  {
    "data": [
      { "first_name": "Jane", "last_name": "Smith",
        "email": "jane@personal.com",        ← optional; helps matching/verification
        "company": "Gensler", "website": "gensler.com" }
    ],
    "siren": true                              ← set true to get EU company registry data (SIREN/SIRET) for FR companies
  }
→ 200: { "request_id": "...", "success": true }

POLL:
GET https://api.dropcontact.io/batch/{request_id}
Headers: X-Access-Token: {key}
→ 200 when ready: enriched records incl. verified email, job, company,
  (Growth) LinkedIn, company firmographics (size, industry, SIREN/NAF for FR).
  While processing returns a not-ready signal → keep polling (Dropcontact
  enrichment is computed, can take seconds to minutes).
```

**Field mapping:** standard helper for job/company/LinkedIn; additionally Dropcontact returns rich EU **company** firmographics — route those into `subscriber_employer_enrichment` (the V2 company table) rather than the person record where appropriate.

**Graceful skip / errors:** **Skip Dropcontact entirely when the subscriber has no name AND no company/domain signal** — it cannot work from a bare email. This is a hard pre-check before enqueuing. On non-EU subscribers, Dropcontact is lower-yield — consider gating it to `li_country` in EU OR `account_country_normalized` in EU when that signal exists. Charge-on-success means misses are mostly free, but budget for the 15–20% no-result-still-charged tail on hard files.

---

### 1.4 Clay — via Webhook (ASYNC) — FUTURE ENTERPRISE STEP ONLY, DO NOT BUILD IN V3

**Role in Lycert:** The aggregator-of-aggregators that produced our ground truth. Worth adding as a **final async sweep for high-value subscribers** — but only once on a Clay **Enterprise** plan, because of the integration constraints below. **This section is documentation for a future step. Do NOT implement in the V3 build.**

**Confirmed integration path (Clay's own docs):**
- **Data in:** Clay tables expose a **Webhook source** — you POST `{email, externalId}` JSON to a per-table webhook URL; the row is created and Clay's configured waterfall runs automatically. An optional auth token can be added to the header.
- **Data back out:** Clay's **HTTP API enrichment column** (set to POST) fires the enriched row to a callback URL of ours — i.e. `/api/v1/enrichment/webhook/clay` — as JSON, using dynamic column references so each row posts its own data. A 200 in the column confirms send.
- **The honest constraints (Clay docs):** Clay has **no traditional synchronous API** on standard plans — "responses might take a minute or more." Webhook **sources are capped at 50,000 submissions per webhook** (persists even after row deletion); only the **Enterprise plan** unlocks **auto-delete / passthrough tables** for unlimited streaming, and only Enterprise unlocks Clay's **direct People/Company API** (send email/LinkedIn URL → person details).

**Why deferred:** the 50k-per-webhook cap and the minute-plus latency make Clay operationally heavy and only clean at Enterprise tier. It is the most expensive option and the least testable. Add it last, gated to Tier-1 / high-value subscribers, once Enterprise is justified. When built, it follows the **exact FullEnrich async pattern** (submit → mark pending → webhook returns → merge), so the V2 async machinery already covers it — only a new `clay_client.py` + a `/webhook/clay` route are needed at that time.

---

## PART 2 — THE REVISED CASCADE

### 2.1 New default order (global; per-tenant overridable via `tenant_waterfall_config`)

```
STAGE 0 (gate):  ZeroBounce validate            ~$0.006   invalid/disposable → STOP
STEP 1:          Hunter people/find             ~$0.004   partial only; near-free first attempt
STEP 2:          Findymail reverse-email (sync) ~2 cr     personal-email specialist; COMPLETE possible if profile has edu/dates, else PARTIAL
STEP 3:          Icypeas reverse (async/poll)   10 cr     GATED: only if not COMPLETE AND priority>=40 (expensive)
STEP 4:          Dropcontact (async/poll)       1 cr/succ CONDITIONAL: only if name+company/domain signal exists; EU-strong
STEP 5:          PDL person/enrich              ~$0.28    deepest education; expensive → late
STEP 6:          FullEnrich reverse (async)     ~$0.05    aggregator sweep; GATED priority>=40; HIGH error rate → low merge trust
STEP 7:          Clay (async webhook)           highest   FUTURE/Enterprise only — not built in V3
DATAGMA:         DEMOTED — disabled by default for EDU population (refuses personal/edu). Keep client; registry enabled=false. Re-enable per-tenant only for corporate-email-heavy verticals.
EXHAUSTED:       enrichment_provider=null, data_gap_all_providers, score on Tier A+B only
```

### 2.2 Ordering rationale
Cost-and-modality ordering: cheapest testable sync personal-email specialist first (Findymail), then the expensive-but-accurate specialists gated by priority (Icypeas), then the conditional name+company tool (Dropcontact), then PDL for its unmatched education depth, then the async aggregator sweeps last. Every expensive step (Icypeas 10cr, FullEnrich, PDL, Clay) runs only on residue the cheap steps couldn't resolve. Two of the new providers are **async (poll-based)** — Part 5 covers how they fit the cascade without blocking.

### 2.3 Stopping rule — unchanged from V2 (Part 2.3)
COMPLETE = (linkedin_url OR (employer_name AND job_title)) AND employment dates present AND education_end_date present → stop, merge, queue scoring. PARTIAL → store with provenance, continue. MISS → continue. After sync steps, async sweep only if not COMPLETE and priority>=40.

### 2.4 Cost model (per 1,000 subscribers — planning numbers, benchmark-derived; REVALIDATE)
```
Stage 0:  1000 × $0.006                                        = $ 6.00
Step 1:   ~950 × $0.004                                        = $ 3.80   (~40% partial)
Step 2:   ~950 × Findymail 2cr, ~45% resolve → ~430            ≈ $ varies by plan; ~$0.02–0.05/lookup
Step 3:   residue × Icypeas 10cr, GATED priority≥40            (small volume; expensive — gate hard)
Step 4:   residue-with-name/company × Dropcontact 1cr/success  (EU-strong; charge-on-success)
Step 5:   residue × PDL $0.28 (only ~20–25% hit)               = largest single line
Step 6:   high-priority residue × FullEnrich ~$0.05            (async)
TOTAL: revalidate against the real benchmark — V2 estimate was ~$0.08/sub at 75–85% coverage.
```
Numbers above are NOT authoritative. The benchmark (Part 8) sets the real order and cost.

---

## PART 3 — SCHEMA CHANGES (additive to V2 migrations 0021–0024)

### Migration `0025_v3_providers.sql`
```sql
-- New registry rows (enrichment_providers table from V2 0021)
INSERT INTO enrichment_providers
  (provider_key, display_name, provider_type, execution_mode, enabled,
   default_position, cost_per_success_usd, returns_education, returns_employment_dates, notes)
VALUES
  ('findymail',  'Findymail',  'enrichment', 'sync',  true, 2,  NULL, false, false,
   'Reverse email→profile. 2 credits with_profile. EU/GDPR. Sync.'),
  ('icypeas',    'Icypeas',    'enrichment', 'async', true, 3,  NULL, false, false,
   'Reverse lookup 10 credits. Poll-based async. EU. Gate to priority>=40.'),
  ('dropcontact','Dropcontact','enrichment', 'async', true, 4,  NULL, false, false,
   'Name+company→email/profile (NOT reverse-email). Async batch poll. EU-strong. Charge-on-success.'),
  ('clay',       'Clay',       'enrichment', 'async', false, 7, NULL, false, false,
   'FUTURE/Enterprise only. Webhook source + HTTP API return. 50k/webhook cap on non-Enterprise.');

-- Reposition existing providers to make room (pdl→5, fullenrich→6), demote datagma
UPDATE enrichment_providers SET default_position = 5 WHERE provider_key = 'pdl';
UPDATE enrichment_providers SET default_position = 6 WHERE provider_key = 'fullenrich';
UPDATE enrichment_providers SET enabled = false, notes =
  'DEMOTED: refuses personal/edu domains (confirmed). Re-enable per-tenant for corporate verticals only.'
  WHERE provider_key = 'datagma';

-- Per-provider priority gate (some providers only run for high-priority subscribers)
ALTER TABLE enrichment_providers ADD COLUMN min_priority integer DEFAULT 0;
UPDATE enrichment_providers SET min_priority = 40 WHERE provider_key IN ('icypeas','fullenrich');

-- Per-provider input requirement (some providers can't run from a bare email)
ALTER TABLE enrichment_providers ADD COLUMN requires_name_company boolean DEFAULT false;
UPDATE enrichment_providers SET requires_name_company = true WHERE provider_key = 'dropcontact';
```

### Migration `0026_v3_async_poll.sql`
```sql
-- V2 had pending_async_provider for webhook (FullEnrich). Add poll support for Icypeas/Dropcontact.
ALTER TABLE subscriber_enrichment ADD COLUMN async_provider_ref text;   -- the provider's job/_id/request_id
ALTER TABLE subscriber_enrichment ADD COLUMN async_provider_mode text;  -- 'webhook' | 'poll'
ALTER TABLE subscriber_enrichment ADD COLUMN async_next_poll_at timestamptz; -- for poll scheduling
ALTER TABLE subscriber_enrichment ADD COLUMN async_poll_count integer DEFAULT 0;
```

No other schema changes — V3 reuses V2's field_provenance, providers_attempted, completeness, per_provider_stats, and the institutions/company tables unchanged.

---

## PART 4 — CODE STRUCTURE (additive)

```
apps/api/services/enrichment/providers/      (or lib/scoring|enrichment per the TS consolidation)
├── findymail_client.py        ← NEW (sync)
├── icypeas_client.py          ← NEW (async, poll-based)
├── dropcontact_client.py      ← NEW (async, poll-based; name+company gate)
├── clay_client.py             ← NOT in V3 (future Enterprise)
├── (existing V2: base, zerobounce, hunter, reversecontact[disabled],
│     datagma[demoted], pdl, fullenrich, apollo[disabled])
```

> ⚠️ **Engine note:** per ENGINE_CONSOLIDATION_PLAN REV 2, the live engine is being consolidated to **TypeScript**. If consolidation has completed by the time V3 is built, implement these three clients in the **TS** enrichment engine (mirroring the existing TS provider clients), NOT in the Python `apps/api`. The contracts in Part 1 are language-agnostic. Confirm which engine is live before writing — do not build V3 providers into the superseded Python engine.

### 4.1 Async poll machinery (shared by Icypeas + Dropcontact)
V2's async handling was webhook-only (FullEnrich). V3 adds **poll-based async**. Implement a shared poller:
- On submit: store `async_provider_ref`, set `async_provider_mode='poll'`, `pending_async_provider=<key>`, `async_next_poll_at = now()+interval`, enqueue nothing else (the cascade for this subscriber pauses at the async step exactly like the webhook case).
- A Supabase pg_cron job (`enrichment_poll_q` worker) selects rows where `pending_async_provider IS NOT NULL AND async_provider_mode='poll' AND async_next_poll_at <= now()`, batches them by provider (respecting each provider's rate limit), calls the provider's result/poll route, and:
  - terminal-success → map + merge (Part 5 rules) → clear pending → queue scoring
  - still-processing → bump `async_poll_count`, set next `async_next_poll_at` with backoff
  - terminal-miss/fail → record outcome, clear pending, continue cascade if more providers remain
- Reuse V2's 24h stale-pending cleanup (also clears poll-mode rows).

### 4.2 `EnrichmentProvider` interface conformance
Each new client implements `enrich(email, name, subscriber_id) -> ProviderResult`. For async providers, `enrich()` performs the SUBMIT and returns `ProviderResult(outcome=PENDING, async_reference=<ref>)`; the poller completes it later. This matches FullEnrich's V2 pattern exactly.

---

## PART 5 — MERGE & PROVENANCE (unchanged rules, two clarifications)

All 6 V2 merge rules apply unchanged. Two V3 clarifications:
1. **Trust ordering for conflicting employment data:** when two providers disagree on current employer, prefer the higher-trust source. Trust order (high→low): PDL > Dropcontact (EU, lowest error) > Findymail/Icypeas (specialists) > FullEnrich (high error rate). Encode as a `trust_rank` on `enrichment_providers` and use it in `merge_fields()` rule #3's "different employer" branch.
2. **Education override (rule #2) unchanged:** PDL's education array still overrides all others. If PDL didn't run/match and Icypeas returned education, Icypeas education stands.

```sql
-- add to 0025
ALTER TABLE enrichment_providers ADD COLUMN trust_rank integer DEFAULT 50;
UPDATE enrichment_providers SET trust_rank = 90 WHERE provider_key='pdl';
UPDATE enrichment_providers SET trust_rank = 85 WHERE provider_key='dropcontact';
UPDATE enrichment_providers SET trust_rank = 70 WHERE provider_key IN ('findymail','icypeas','reversecontact','datagma');
UPDATE enrichment_providers SET trust_rank = 75 WHERE provider_key='hunter';
UPDATE enrichment_providers SET trust_rank = 50 WHERE provider_key='fullenrich';  -- high error rate
```

---

## PART 6 — SETTINGS UI (additive to V2 Part 6)
Three new provider cards (Findymail, Icypeas, Dropcontact) following the existing V2 card pattern: status badge, masked key input, "Test connection", MTD spend. The drag-to-reorder waterfall panel already reads `enrichment_providers` + `tenant_waterfall_config` — the new rows appear automatically. Datagma's card shows a "Demoted — corporate verticals only" note. Clay's card is hidden until Enterprise (gate on `tenant.plan_tier = 'enterprise'`).

New env vars (both staging and production):
```
LYCERT_FINDYMAIL_API_KEY=
LYCERT_ICYPEAS_API_KEY=
LYCERT_DROPCONTACT_API_KEY=
# future: LYCERT_CLAY_WEBHOOK_URL / LYCERT_CLAY_AUTH_TOKEN (Enterprise step, not V3)
```

---

## PART 7 — GDPR (additive to V2 Part 7)
Three new sub-processors, all France/EU — a net improvement to transfer posture:
- **Findymail** (France) — DPA + GDPR pages published; add to `sub_processor_registry`.
- **Icypeas** (France) — GDPR + CCPA + ISO 27001; open-source-intelligence only (document this — it's a stronger basis than scraped-DB providers).
- **Dropcontact** (France) — markets 100% GDPR-compliant computed (not stored) data; strong basis; no mobile numbers by design (aligns with our no-phone rule).
All three: 30-day raw deletion applies; the `emails`/`phones` arrays they may return are NEVER stored (we have the email; phones are excluded). Update Privacy Policy sub-processor list and the next LIA revision (note the EU-shift strengthens the legitimate-interest balancing test).

---

## PART 8 — TESTING & THE BENCHMARK (this is the gate, not the cascade order above)

### 8.1 Unit tests (fixtures, no live calls) — required before staging
- `test_findymail_mapper` (full profile, core-only response, 404, wrong-person guard).
- `test_icypeas_async` (submit→NONE, poll→DEBITED success, poll→not-found, poll→FAILED, externalId round-trip, 30/min bucket).
- `test_dropcontact_async` (submit→request_id, poll-not-ready→poll-ready, name+company gate skips bare-email subscribers, charge-on-success accounting, EU-gating).
- `test_merge_trust_rank` (PDL beats Dropcontact beats Findymail beats FullEnrich on employer conflict).
- `test_poll_worker` (backoff, 24h cleanup, rate-limit batching).

### 8.2 THE BENCHMARK — run BEFORE signing any paid plan
Extend `scripts/benchmark_providers.py` (V2 Part 8.2) to include Findymail, Icypeas, Dropcontact. **Expand the sample to 20–50 subscribers including the Malta (.edu.mt) and Brazil (hotmail) gaps and several corporate-email subscribers** (to fairly re-test Datagma). Run each provider in isolation against Clay ground truth. Score each on: hit rate, education coverage, employment-dates coverage, wrong-person count, effective $/hit, and **specifically whether it resolves S3 (Malta) and S5 (Brazil)**. Free tiers suffice to start: Findymail (instant free key), Icypeas (50 credits ≈ 5 reverse lookups — enough for a spot check), Dropcontact (free test without card per their docs). Record results in DECISIONS.md and set the final `default_position` + `min_priority` from MEASURED data. Drop any provider under ~15% measured hit rate on our population. The cascade order in Part 2.1 is the hypothesis; the benchmark is the verdict.

---

## PART 9 — SOURCES (official docs verified for this spec)
- Findymail API: https://www.findymail.com/api/ and https://app.findymail.com/docs/ (reverse-email endpoint, 1/2-credit model, Bearer auth, GDPR/DPA pages)
- Icypeas API: https://api-doc.icypeas.com/getting-started/ , https://api-doc.icypeas.com/category/api-authorization/ (submit→poll flow, status values, signature scheme); pricing (10 cr/reverse lookup, 50 free credits, rollover): icypeas.com/pricing
- Dropcontact API: https://support.dropcontact.com/article/237-how-to-use-the-dropcontact-api-key , batch endpoint https://api.dropcontact.io/batch + /batch/{request_id} (X-Access-Token, pay-on-success, EU strength / non-EU weakness, Growth-tier LinkedIn enrichment)
- Clay (future): https://university.clay.com/docs/webhook-integration-guide , https://university.clay.com/docs/using-clay-as-an-api , https://university.clay.com/docs/http-api-integration-overview (no traditional API, 50k webhook cap, Enterprise auto-delete + People/Company API)
- Independent benchmark (FullEnrich error rate, Dropcontact #1): dropcontact.com/email-finder-benchmark

## PART 10 — WHAT CLAUDE CODE MUST NOT DO (additive to V2 Part 9)
- Do not build the Clay integration in V3 — it is documented for a future Enterprise step only.
- Do not call Dropcontact on bare-email subscribers (no name+company) — hard pre-check.
- Do not run Icypeas on low-priority subscribers — it's 10 credits; gate to priority>=40.
- Do not store provider-returned `emails`/`phones` arrays — GDPR exclusion, every provider.
- Do not invent endpoint paths/field keys flagged "confirm at impl time" (Findymail extended profile fields; Icypeas exact reverse-lookup route + no-match status string; Dropcontact LinkedIn-field plan gating) — fetch the live docs and verify before coding.
- Do not build V3 providers into the superseded Python engine if TS consolidation is live — confirm the engine first.
- Do not re-enable Datagma globally — it stays demoted; per-tenant corporate-vertical opt-in only.

*End of LYCERT_WATERFALL_ENRICHMENT_V3.md — Version 3.0*

---

## IMPLEMENTATION STATUS ADDENDUM (Claude Code, 2026-06-22)
*Not part of the original spec. Maps the spec to the actual repo state so the build doesn't drift.*

**This doc is now the FULL-PRIORITY active spec.** It is committed to the repo and is the authoritative
target for the current build. Status: **architecture phase started; no V3 provider code written yet.**

### Two corrections the spec author couldn't know (verified against the live repo)
1. **Migration numbers.** The spec proposes `0025_v3_providers.sql` and `0026_v3_async_poll.sql`. Those
   numbers are **already taken** — the live TS engine shipped migrations through **`0034`** (V2 used
   `0024–0031`; then `0032` academic_domains, `0033` soft-delete, `0034` fullenrich async_reference).
   → **V3 migrations must be `0035_v3_providers.sql` and `0036_v3_async_poll.sql`.** Apply the EXACT SQL
   bodies the spec gives in Part 3 (registry rows + repositioning + `min_priority` + `requires_name_company`
   + `trust_rank`; async-poll columns), just under the corrected filenames. Per CLAUDE.md Migration Rule,
   apply to **both** staging (`<staging-project-ref>`) AND prod (`<prod-project-ref>`).
2. **Engine = TypeScript (confirmed live).** Per ENGINE_CONSOLIDATION_PLAN REV 2, consolidation to TS is
   **done** — the live engine is `apps/web/lib/enrichment/` (cascade.ts, worker.ts, worker-io.ts,
   providers/clients.ts, fullenrich.ts, fullenrich-apply.ts, etc.). **Build the three V3 clients in the TS
   engine**, mirroring the existing TS provider clients — NOT in the dormant Python `apps/api`. Part 4's
   Python paths are illustrative only. (Keep the Python `apps/api` reference-oracle untouched; optionally
   mirror the clients there later for parity, but the live path is TS.)

### Existing async machinery to reuse (don't rebuild)
- V2 already has webhook-async (FullEnrich): `pending_async_provider` column, `async_reference` +
  `async_submitted_at` (migration 0034), the `/api/enrichment/webhook/fullenrich` receiver, the
  `/api/enrichment/fullenrich-timeout` poll-reconcile+timeout route (pg_cron `*/15`), and the shared
  idempotent `applyFullenrichItem`. **The new poll-based async (Icypeas/Dropcontact) is a NEW pattern**
  (submit→poll, not webhook) — build the shared poller per Part 4.1 using the `0036` poll columns, but
  reuse the pending-state lifecycle, the 24h stale-cleanup, and the `q_job_accumulate` accounting hooks.
- Cron: a new `lycert-enrichment-poll` pg_cron schedule (poll worker) joins the existing three
  (enrichment-worker `*/1`, scoring-worker `*/1`, fullenrich-timeout `*/15`). Vault-secret + bypass-header
  pattern is already established (see NEXT_STEPS.md activation notes) — follow it.

### External dependency (gates the benchmark, Part 8.2 — NOT the code)
New env vars needed in Vercel (Preview + Production) before any live call: `LYCERT_FINDYMAIL_API_KEY`,
`LYCERT_ICYPEAS_API_KEY`, `LYCERT_DROPCONTACT_API_KEY`. All three have testable free tiers (the whole
point of choosing them). Clients must degrade to a clean MISS when their key is absent (same pattern as
Datagma did). **The benchmark verdict — not Part 2.1's hypothesised order — sets final `default_position`
+ `min_priority`; record it in DECISIONS.md.**

### V3 BUILD SEQUENCE (authoritative running order — see NEXT_STEPS.md "NOW")
1. Migrations `0035` + `0036` (staging + prod).
2. TS clients: `findymail` (sync), `icypeas` (async-poll), `dropcontact` (async-poll, name+company gate).
3. Shared poll worker + `lycert-enrichment-poll` cron; wire cascade `min_priority` / `requires_name_company`
   gates + `trust_rank` into the merge.
4. Unit tests (Part 8.1) — fixtures, no live calls — green before staging.
5. Settings UI: three provider cards (auto-appear from registry) + Datagma "demoted" note.
6. Joshua adds the 3 keys → run the expanded benchmark (Part 8.2, 20–50 subs incl. S3 Malta / S5 Brazil) →
   record in DECISIONS.md → set measured cascade order → activate the poll cron.
7. GDPR: add Findymail/Icypeas/Dropcontact to `sub_processor_registry`; flip `active` when DPA collected.
8. Clay = NOT built (future Enterprise only, Part 1.4 / Part 10).

### Carried over from V2 — STILL OPEN, do not let V3 bury these (also in NEXT_STEPS.md)
- **Job-completion lifecycle** unwired — enrichment jobs stay `status='running'`, so dashboard MTD spend
  (filters `status='completed'`) never surfaces the per-provider stats. (V3 adds providers → MORE spend to
  surface → this matters more now.)
- **Prod pipeline activation** — pg_cron schedules + Vault secrets + the FullEnrich webhook URL are
  **staging-only**; prod is dormant. Repeat on `lycert-prod` when promoting.
- **`LYCERT_FULLENRICH_WEBHOOK_SECRET`** — to add in Vercel + re-pull `.env.local` (staging) and on prod.
- **Re-import corrected CSV for tenant `<test-tenant-id>`** (European date misparse on non-NULL rows) then Pre-Enrich All.
- **Tenant scoring overrides** (`tenant_scoring_config`) not yet layered into the scoring worker.
- 14 legacy FullEnrich-pending rows (no `async_reference`) time out at 24h — expected, unrecoverable.
- ReverseContact stays **disabled** (trial can't enrich); V3 keeps it demoted — no PAYG decision needed now.
