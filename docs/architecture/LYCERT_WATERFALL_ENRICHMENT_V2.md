# LYCERT_WATERFALL_ENRICHMENT_V2.md
**Version:** 2.0
**Date:** June 2026
**Status:** Authoritative. Supersedes the provider sections of LYCERT_ENRICHMENT_ARCHITECTURE.md (Parts 1.2–1.4 and the PDL→Apollo fallback flow in Part 2). All other parts of that document (pre-enrichment free APIs, field deletion rules, GDPR constraints, enrichment_jobs table) remain in force.
**For Claude Code:** Read this entire document before modifying `apps/api/services/enrichment/`. Check the repo's current state first — `pdl_client.py`, `field_mapper.py`, and the orchestrator already exist and are working. This is an EXTENSION, not a rewrite.

---

## ⚙ IMPLEMENTATION STATUS (addendum, 2026-06-20 — committed to repo this session)

> This authoritative design doc previously lived only outside the repo; it is now committed. The
> design below was **built**, but on the **TypeScript** engine, not the Python `apps/api/...` paths in
> Part 4 (the engine was consolidated to TS — see `ENGINE_CONSOLIDATION_PLAN.md`). Read this block for
> the design→code/migration mapping; the rest of the document is the authoritative spec.

**Where the code actually lives (TS):** `apps/web/lib/enrichment/` — `providers/` (`base.ts`,
`clients.ts`, `zerobounce.ts`, `fullenrich.ts`, `mappers.ts`, `index.ts`), `cascade.ts`, `merge.ts`,
`worker.ts`, `worker-io.ts`. Routes: `/api/enrichment/{enqueue,worker,waterfall}`, `/api/scoring/worker`.

**Schema (live on staging `<staging-project-ref>`):** the Part 3 tables shipped as migrations
**0024–0031** (not the 0021–0024 numbers in Part 3): provider registry, `tenant_waterfall_config`,
`field_provenance`, email-validation/job-stats, `sub_processor_registry`, pgmq+pg_cron queue runtime,
`q_job_accumulate`.

**Live cascade order (from the `enrichment_providers` registry):** Hunter (1) → ReverseContact (2) →
Datagma (3) → PDL (4) → FullEnrich (5, async) → Apollo (6, disabled). ZeroBounce = Stage-0 validation gate.

**DONE:** all sync provider clients + mappers, ZeroBounce gate, cascade + merge engine, FullEnrich
async + webhook, durable queue workers, Settings → Integrations waterfall panel, 85 Vitest tests,
benchmark script (`scripts/benchmark_providers.py`).

**PENDING to close this doc (the remaining setup):**
1. **Provider API keys** (Joshua, free tiers): `LYCERT_ZEROBOUNCE_API_KEY`, `LYCERT_HUNTER_API_KEY`,
   `LYCERT_REVERSECONTACT_API_KEY`, `LYCERT_DATAGMA_API_KEY`, `LYCERT_FULLENRICH_API_KEY` (+ webhook URL).
2. **Run the benchmark** (Part 8.2) → record results in `DECISIONS.md` → set the final cascade order.
3. **Activate the pipeline:** `CRON_SECRET` in Vercel + create the pg_cron schedules (see `NEXT_STEPS.md`).
4. **Job-completion lifecycle** gap: nothing sets `enrichment_jobs.status='completed'` yet (dashboard
   MTD spend stays hidden until wired).
5. **GDPR:** flip `sub_processor_registry.active=true` per provider once its DPA/SCC is collected.
6. Migrations on `lycert-prod` + Joshua merge `staging`→`main`.

---

## PART 0 — WHY THIS CHANGE, AND WHAT CHANGES

### 0.1 The problem we measured
PDL missed 2 of 3 test subscribers from the design-partner ground-truth sample. Root cause: Lycert's subscribers are students using **personal emails** (gmail.com, web.de, naver.com). PDL and Apollo index people primarily by work email and company. Personal-email reverse lookup is a different provider category, and we had zero providers from it.

Additionally: Apollo's People Enrichment API requires a paid plan — it does not work on the free tier even with free credits (confirmed in our own debugging). Apollo is therefore REMOVED from the default waterfall (it can return later as an optional enterprise add-on if a paid plan is ever justified).

### 0.2 What stays the same
- The pre-enrichment layer (School Cleaner, Location Cleaner, email domain classification) — unchanged, still runs first, still free
- The 30-day raw-data deletion rule — unchanged, applies to every new provider
- The fields stored in `subscriber_enrichment` — same schema, now populated from more sources
- The GDPR field exclusions (no gender, no birth_year, no phones) — apply to EVERY provider below
- The `enrichment_jobs` cost-tracking table — extended, not replaced
- The scoring engine — completely unchanged; it reads `subscriber_enrichment` and does not care which provider filled it

### 0.3 What changes
1. **Single fallback → configurable waterfall.** The hardcoded PDL→Apollo chain becomes a provider registry with an ordered cascade, defined per-tenant in config (with a global default).
2. **Five new provider clients** (ZeroBounce, Hunter, ReverseContact, Datagma, FullEnrich) following the same interface as the existing `pdl_client.py`.
3. **Sync + async providers.** FullEnrich is asynchronous (webhook delivery). The orchestrator gains a pending-state and a webhook receiver endpoint.
4. **Per-field provenance.** Each stored field records which provider supplied it, because a final record may be merged from 2+ providers.
5. **Stage 0 validation gate.** No paid lookup ever runs on an undeliverable or disposable email.

---

## PART 1 — PROVIDER REFERENCE (Ground Truth Per Provider)

Every provider client implements the same interface (Part 4). This section is the exact API contract for each.

---

### 1.1 STAGE 0 — ZeroBounce (Email Validation — runs before ANY paid lookup)

**Role in Lycert:** Gate. Filters dead/disposable addresses so the waterfall never spends a credit on them.
**Pricing:** Pay-as-you-go credits, ~$0.004–0.008 per validation depending on volume tier. 100 free validations/month on free account.
**Auth:** API key as query parameter (ZeroBounce's documented method).
**Rate limits:** Generous; batch endpoint available (up to 200 emails per request).

```
GET https://api.zerobounce.net/v2/validate
Params:
  api_key    = {LYCERT_ZEROBOUNCE_API_KEY}
  email      = subscriber@example.com
  ip_address = ""        ← always send empty string (required param)

Response (key fields):
{
  "address": "subscriber@example.com",
  "status": "valid",            ← valid | invalid | catch-all | unknown | spamtrap | abuse | do_not_mail
  "sub_status": "",             ← e.g. "disposable", "role_based", "toxic"
  "free_email": true,           ← true for gmail/yahoo etc — useful signal, store it
  "domain": "gmail.com",
  "mx_found": "true",
  "did_you_mean": null          ← typo suggestion e.g. "gmail.com" for "gmial.com"
}

Batch:
POST https://api.zerobounce.net/v2/validatebatch
Body: {"api_key": "...", "email_batch": [{"email_address": "...", "ip_address": ""}, ...]}  ← max 200
```

**Lycert decision logic:**
| ZeroBounce result | Action |
|---|---|
| `status = valid` | Proceed to waterfall |
| `status = catch-all` | Proceed to waterfall (catch-all is common for university domains) |
| `status = invalid` | STOP. Mark `email_validation_status = 'invalid'`. Record data_gap `email_undeliverable`. Waterfall skipped entirely. |
| `sub_status = disposable` | STOP. Set `email_domain_type = 'disposable'` (this is itself a B1 scoring signal). Waterfall skipped. |
| `status = unknown` | Proceed to waterfall (don't lose coverage on ZeroBounce uncertainty) |
| `did_you_mean` populated | Store suggestion in `email_typo_suggestion`; surface in dashboard; do NOT auto-correct (the subscriber's submitted email is canonical) |

**New columns on `subscribers`:**
```sql
ALTER TABLE subscribers ADD COLUMN email_validation_status text;     -- valid/invalid/catch_all/unknown/disposable
ALTER TABLE subscribers ADD COLUMN email_validated_at timestamptz;
ALTER TABLE subscribers ADD COLUMN email_typo_suggestion text;
```
Validation results are cached for 180 days — never re-validate an email validated within that window.

---

### 1.2 WATERFALL STEP 1 — Hunter Enrichment API (Cheap First Pass)

**Role in Lycert:** Cheapest professional lookup. Catches the easy hits for pennies before expensive providers run.
**Coverage expectation:** ~44% match rate on reverse lookups; database smaller than LinkedIn (<25%). Low cost makes it worth running first anyway.
**Pricing:** Each Enrichment API call uses one search credit; reverse lookups effectively ~0.2 credit per matched email (~$0.003–0.005/match at plan rates). Plans from ~$34/mo. Free plan: 25 searches/month — enough for integration testing.
**Auth:** API key as query parameter.

```
GET https://api.hunter.io/v2/people/find
Params:
  email   = subscriber@example.com
  api_key = {LYCERT_HUNTER_API_KEY}

Response (200 with match):
{
  "data": {
    "name": {"fullName": "Jane Smith", "givenName": "Jane", "familyName": "Smith"},
    "email": "subscriber@example.com",
    "location": "Berlin, Germany",
    "geo": {"city": "berlin", "country": "DE"},
    "employment": {
      "domain": "gensler.com",
      "name": "Gensler",
      "title": "Junior Architect",
      "role": "design",
      "seniority": "junior"
    },
    "linkedin": {"handle": "in/janesmith"}
  }
}
404 = no match.
```

**Field mapping (Hunter → subscriber_enrichment):**
| Hunter field | Column | Note |
|---|---|---|
| `employment.name` | `li_current_employer_name` | |
| `employment.domain` | `li_current_employer_domain` | |
| `employment.title` | `li_job_title` | |
| `employment.seniority` | `li_job_title_levels` | wrap single value in array |
| `linkedin.handle` | `linkedin_profile_url` | prefix `https://linkedin.com/` |
| `geo.country` | `li_country` | ISO code → expand via Location Cleaner |

**What Hunter does NOT return:** education history, job start/end dates. A Hunter-only match always records data_gaps `education_history` and `employment_dates`. Hunter alone can never satisfy C3; it CAN satisfy C1 (employer present = likely currently employed, mark confidence low), C2 (title), C4 (domain).

**Continuation rule:** Hunter hit does NOT stop the waterfall. Because Hunter lacks education and dates, a Hunter hit downgrades to "partial" and the waterfall continues to Step 2+. Hunter's data is kept and merged later (Part 5). The waterfall only stops early on a COMPLETE result (defined in Part 2.3).

---

### 1.3 WATERFALL STEP 2 — ReverseContact (Personal-Email Specialist)

**Role in Lycert:** The personal-email → LinkedIn-profile specialist. This is the provider class that caught what PDL missed in the design-partner sample. Returns full profile INCLUDING education history.
**Coverage expectation:** ~53% match rate benchmark; explicitly built for personal emails.
**Pricing:** Starter $39/mo = 1,000 credits; Growth $99/mo = 5,000 credits. 1 credit per reverse email lookup. Effective ~$0.02–0.04/lookup. NOTE: reviews report credits sometimes consumed on no-match — log every call and reconcile monthly against their `/v2/usage` endpoint (free to call).
**Auth:** API key as query parameter.
**Rate limit:** 15 requests/second — enforce a token bucket in the client.

```
GET https://api.reversecontact.com/enrichment
Params:
  apikey = {LYCERT_REVERSECONTACT_API_KEY}
  mail   = subscriber@example.com

Response (match):
{
  "success": true,
  "email": "subscriber@example.com",
  "person": {
    "firstName": "Jane",
    "lastName": "Smith",
    "headline": "Junior Architect at Gensler",
    "location": "Berlin, Germany",
    "linkedInUrl": "https://linkedin.com/in/janesmith",
    "positions": {
      "positionsCount": 2,
      "positionHistory": [
        {
          "title": "Junior Architect",
          "companyName": "Gensler",
          "companyLocation": "Berlin, Germany",
          "startEndDate": {"start": {"month": 2, "year": 2024}, "end": null}
        }
      ]
    },
    "schools": {
      "educationsCount": 1,
      "educationHistory": [
        {
          "schoolName": "University of Stuttgart",
          "degreeName": "Bachelor of Architecture",
          "fieldOfStudy": "Architecture",
          "startEndDate": {"start": {"year": 2018}, "end": {"year": 2023}}
        }
      ]
    }
  },
  "company": { "name": "Gensler", "websiteUrl": "gensler.com", "industry": "Architecture & Planning", "employeeCount": 6000 }
}
No-match: {"success": false}
```

**Field mapping:**
| ReverseContact field | Column |
|---|---|
| `person.linkedInUrl` | `linkedin_profile_url` |
| current position `title` (entry with end=null, else most recent) | `li_job_title` |
| current position `companyName` | `li_current_employer_name` |
| `company.websiteUrl` | `li_current_employer_domain` |
| `company.industry` | `li_employer_industry` |
| `company.employeeCount` → band | `li_employer_size` |
| position `startEndDate.start` | `li_job_start_date` (YYYY-MM-01) |
| position `startEndDate.end` | `li_job_end_date` (null = currently employed) |
| latest `educationHistory.startEndDate.end.year` | `li_education_end_date` (Dec 31 of year — conservative, same rule as PDL mapper) |
| latest `educationHistory.schoolName` | `li_education_institution` |
| `person.location` → Location Cleaner | `li_country` / `li_state` / `li_city` |

ReverseContact returns BOTH employment dates AND education — it can produce a COMPLETE result and stop the waterfall.

---

### 1.4 WATERFALL STEP 3 — Datagma (Unique-Find Real-Time Provider)

**Role in Lycert:** Real-time lookup against live web sources (not a static DB). Benchmarks show 57.7% hit rate and a high count of unique finds other providers miss — ideal after ReverseContact because their coverage doesn't fully overlap. GDPR-positioned (real-time retrieval, no stored database) — a genuine plus for our EU posture.
**Pricing:** Discover $39/mo = 1,000 credits; Growth $99/mo = 5,000; Business $249/mo = 20,000. Free trial credits on signup. Person enrichment ~1 credit (phone data costs ~30x — we NEVER request phone data).
**Auth:** API key as query parameter.

```
GET https://gateway.datagma.net/api/ingress/v2/full
Params:
  apiId          = {LYCERT_DATAGMA_API_KEY}
  email          = subscriber@example.com
  companyPremium = false      ← we do not pay for premium company data here
  phoneFull      = false      ← NEVER true. 30x cost and GDPR-unnecessary.
  findEmailV2    = false      ← we already have the email

Response (match) — key paths:
{
  "person": {
    "basic": {
      "fullName": "Jane Smith",
      "title": "Junior Architect",
      "linkedInUrl": "https://linkedin.com/in/janesmith",
      "location": "Berlin, Germany"
    },
    "details": {
      "positions": {"positionHistory": [ {company, title, startEndDate...} ]},
      "schools":   {"educationHistory": [ {schoolName, degreeName, startEndDate...} ]}
    }
  },
  "company": {"basic": {"name": "Gensler", "website": "gensler.com", "size": "5001-10000", "industry": "..."}}
}
```

**Field mapping:** structurally identical to ReverseContact (same positionHistory/educationHistory shape) — implement one shared `_map_linkedin_style_profile()` helper in `field_mapper.py` used by both clients, with provider-specific path extraction.

Datagma returns education + dates → can produce a COMPLETE result.

---

### 1.5 WATERFALL STEP 4 — PDL Person Enrichment (EXISTING — Position Change Only)

**Everything in LYCERT_ENRICHMENT_ARCHITECTURE.md Part 1.2 stays valid** — same endpoint, same `min_likelihood=4`, same `required="experience AND education"`, same bulk endpoint, same field mapper, same $0.28/match.

**What changes:** PDL moves from waterfall position 1 to position 4. Rationale: PDL has the deepest, most structured education data WHEN it hits, but its hit rate on personal emails is the lowest in our stack and its per-match cost is the highest. It runs after the cheaper personal-email specialists so it only spends $0.28 on records they couldn't resolve.

**Optional "education upgrade pass" (config-gated, default OFF):** because PDL's education array always overrides other providers' education fields (Part 5, rule 2), Tier-1 candidates already resolved by ReverseContact/Datagma MAY additionally be PDL-enriched to upgrade education data quality when budget allows.

---

### 1.6 WATERFALL STEP 5 — FullEnrich (Waterfall-of-Waterfalls, ASYNC)

**Role in Lycert:** Final sweep. One API that internally cascades 15+ providers (Apollo, Dropcontact, Hunter, Datagma, Findymail, RocketReach, BetterContact, and others) and charges 1 credit only on success. Where standalone providers match 50–60%, FullEnrich's waterfall routinely lifts to 75–90%. It has a dedicated **Reverse Email Lookup API** — exactly our input shape. SOC 2 Type II, GDPR/CCPA compliant per their docs.
**Pricing:** From $59/mo = 1,000 credits; one-time packs $0.04–0.06/credit at volume. 1 credit per successful email-side match; person/company data included with a lookup; credits charged only on success. 50 free credits to test. NOTE: monthly credits don't roll over by default; one-time packs expire after 6 months — buy packs sized to measured volume.
**Auth:** `Authorization: Bearer {key}` header.
**CRITICAL — ASYNC:** The Enrich and Reverse Email Lookup APIs are asynchronous: requests return immediately with an enrichment_id; results arrive via webhook (or polling `GET /bulk/{enrichment_id}`). Typical completion 30–90 seconds. Webhook delivery retries every minute up to 5 times on non-2xx; payload authenticity verifiable via SHA1-signed header against the API key.

```
Submit (bulk, up to 100 contacts):
POST https://app.fullenrich.com/api/v2/contact/enrich/bulk
  ← Claude Code: confirm exact current path + reverse-email-lookup variant against docs.fullenrich.com at implementation time
Headers: Authorization: Bearer {key}, Content-Type: application/json
Body:
{
  "name": "lycert_batch_{enrichment_job_id}",
  "webhook_url": "https://api.lycert.ai/api/v1/enrichment/webhook/fullenrich",
  "datas": [
    {
      "firstname": "Jane",
      "lastname": "Smith",
      "enrich_fields": ["contact.emails"],
      "custom": {"lycert_subscriber_id": "uuid", "lycert_job_id": "uuid"}   ← passthrough, REQUIRED
    }
  ]
}
→ 200 {"enrichment_id": "..."}

Result (webhook POST to our endpoint; same shape as GET /bulk/{enrichment_id}):
{
  "id": "...", "status": "FINISHED",
  "datas": [
    {
      "custom": {"lycert_subscriber_id": "...", "lycert_job_id": "..."},
      "contact": {
        "firstname": "...", "lastname": "...",
        "linkedin_url": "...",
        "job_title": "...", "company_name": "...", "company_domain": "...",
        "location": "..."
      }
    }
  ]
}
```

**Implementation notes:**
- Verify the SHA1 signature header on every webhook delivery before processing. Reject unsigned/invalid payloads with 401.
- The webhook endpoint must be idempotent: FullEnrich retries on non-2xx, and duplicate deliveries must not double-write enrichment records or double-count credits.
- Education coverage is provider-dependent (depends on which internal source matched). Map what arrives; record data_gaps for whatever is absent.
- Check credit balance before submitting batches: `GET https://app.fullenrich.com/api/v1/account/credits` (Bearer auth).

---

### 1.7 REMOVED / OPTIONAL PROVIDERS

| Provider | Status | Reason |
|---|---|---|
| **Apollo** | REMOVED from default waterfall | People Enrichment API requires a paid plan (confirmed — does not work on free tier). No education data anyway. Keep `apollo_client.py` in the codebase, mark `enabled=false` in the registry. May return as enterprise add-on. |
| **Enrich Layer** | OPTIONAL, not in v2 default | Reverse Email Lookup at 3 credits/success, explicitly supports personal+work emails. Proxycurl lineage = elevated legal/continuity risk (LinkedIn sued Nubela/Proxycurl in 2025; both services deprecated). Revisit only if measured coverage gap persists after v2. |
| **Clay (webhook table)** | OPTIONAL Phase-3+ sweep | Async Clay-table pattern (webhook in → waterfall → HTTP API out) documented in prior session. Only for Tier-1 candidates if FullEnrich leaves a gap. Not part of v2 build. |

---

## PART 2 — THE WATERFALL: ORDER, STOPPING RULES, COST MODEL

### 2.1 Default cascade (global config, overridable per tenant)

```
STAGE 0 (gate):    ZeroBounce validate          ~$0.006   → invalid/disposable: STOP
STEP 1:            Hunter people/find           ~$0.004   → partial only, never stops waterfall
STEP 2:            ReverseContact enrichment    ~$0.030   → COMPLETE possible
STEP 3:            Datagma /full                ~$0.030   → COMPLETE possible
STEP 4:            PDL person/enrich            ~$0.280   → COMPLETE possible (best education data)
STEP 5:            FullEnrich reverse lookup    ~$0.050   → async final sweep
EXHAUSTED:         enrichment_provider = null, data_gap_all_providers, score on Tier A+B only
```

### 2.2 Why this order
Cost-ascending for the sync steps, with the personal-email specialists (our measured gap) ahead of PDL (our measured miss). FullEnrich last because it is async (30–90s) — it must not block the sync cascade — and because its internal waterfall overlaps with steps 1–4; running it last means we only pay it for the residue.

### 2.3 The COMPLETE / PARTIAL stopping rule
A provider result is **COMPLETE** when ALL of:
1. `linkedin_profile_url` OR (`li_current_employer_name` AND `li_job_title`) present
2. Employment dates present (`li_job_start_date`, with `li_job_end_date` present-or-explicitly-null)
3. `li_education_end_date` present

COMPLETE → stop the waterfall, merge, queue scoring.
**PARTIAL** (anything found, but missing requirement 2 or 3) → store fields with provenance, CONTINUE waterfall; later providers fill only the gaps (Part 5).
**MISS** → continue.

After the sync cascade (steps 1–4), if the merged record is still not COMPLETE and the subscriber's `enrichment_priority` ≥ 40 (computed by the existing priority engine), queue FullEnrich. Below 40, accept the partial result — don't pay the sweep for low-priority records.

### 2.4 Cost model (per 1,000 subscribers, planning numbers)
```
Stage 0: 1000 × $0.006                                    = $ 6.00
Step 1:  ~950 valid × $0.004 effective                    = $ 3.80   (~40% partial hits)
Step 2:  950 × ~$0.03, ~50% COMPLETE → 475 resolved       = $28.50
Step 3:  475 remaining × $0.03, ~35% → ~166 resolved      = $14.25
Step 4:  309 remaining × $0.28 only on 200s (~25% hit)    = $21.60
Step 5:  ~230 high-priority residue × $0.05 on success    = ~$8.00
TOTAL                                                      ≈ $82 / 1,000  ≈ $0.08 per subscriber
Coverage estimate: 75–85% vs PDL-alone ~33% at $0.28/hit.
```
These are benchmark-derived planning numbers. The REQUIRED first action after build (Part 8.2) is benchmarking all providers against the design-partner ground-truth sample; reorder the cascade based on measured, not benchmark, hit rates.

---

## PART 3 — SCHEMA CHANGES

### 3.1 Migration `0021_provider_registry.sql`
```sql
CREATE TABLE enrichment_providers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_key text UNIQUE NOT NULL,      -- 'zerobounce','hunter','reversecontact','datagma','pdl','fullenrich','apollo'
    display_name text NOT NULL,
    provider_type text NOT NULL,            -- 'validation' | 'enrichment'
    execution_mode text NOT NULL,           -- 'sync' | 'async'
    enabled boolean NOT NULL DEFAULT true,
    default_position integer,               -- waterfall order; null for validation stage
    cost_per_success_usd numeric(8,4),
    returns_education boolean NOT NULL DEFAULT false,
    returns_employment_dates boolean NOT NULL DEFAULT false,
    notes text
);
-- Seed rows: zerobounce(validation,sync), hunter(pos 1, no edu, no dates),
-- reversecontact(pos 2, edu, dates), datagma(pos 3, edu, dates), pdl(pos 4, edu, dates),
-- fullenrich(pos 5, async, provider-dependent edu), apollo(enabled=false).
-- This is a GLOBAL table (no tenant_id, no RLS) — read-only to tenants.
```

### 3.2 Migration `0022_tenant_waterfall_config.sql`
```sql
CREATE TABLE tenant_waterfall_config (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
    provider_key text REFERENCES enrichment_providers(provider_key),
    position integer NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    UNIQUE(tenant_id, provider_key),
    UNIQUE(tenant_id, position)
);
-- Empty for a tenant = use global default order from enrichment_providers.default_position.
-- RLS: tenant_id isolation, same pattern as all tenant tables.
```

### 3.3 Migration `0023_field_provenance.sql`
```sql
ALTER TABLE subscriber_enrichment ADD COLUMN field_provenance jsonb DEFAULT '{}'::jsonb;
-- e.g. {"li_job_title":"reversecontact","li_education_end_date":"pdl","li_country":"hunter"}
ALTER TABLE subscriber_enrichment ADD COLUMN providers_attempted jsonb DEFAULT '[]'::jsonb;
-- ordered list with outcomes: [{"provider":"hunter","outcome":"partial"},{"provider":"reversecontact","outcome":"complete"}]
ALTER TABLE subscriber_enrichment ADD COLUMN completeness text DEFAULT 'miss';
-- 'complete' | 'partial' | 'miss'
ALTER TABLE subscriber_enrichment ADD COLUMN pending_async_provider text;
-- 'fullenrich' while awaiting webhook; null otherwise
```
`enrichment_provider` (existing column) now means "provider that supplied the majority of fields" — kept for backward compatibility with the dashboard.

### 3.4 Migration `0024_email_validation_and_job_stats.sql`
The three `subscribers` columns from Part 1.1, plus extend `enrichment_jobs`:
```sql
ALTER TABLE enrichment_jobs ADD COLUMN per_provider_stats jsonb DEFAULT '{}'::jsonb;
-- {"hunter":{"attempts":950,"hits":380,"cost_usd":3.80}, "reversecontact":{...}, ...}
ALTER TABLE enrichment_jobs ADD COLUMN async_pending_count integer DEFAULT 0;
```

---

## PART 4 — CODE STRUCTURE

```
apps/api/services/enrichment/
├── orchestrator.py            ← MODIFIED: registry-driven cascade, partial-merge + async handoff
├── pre_enrichment.py          ← unchanged
├── field_mapper.py            ← MODIFIED: add _map_linkedin_style_profile() shared helper + per-provider mappers
├── priority_queue.py          ← unchanged
├── credit_tracker.py          ← MODIFIED: per-provider stats
├── company_enrichment.py      ← unchanged
├── providers/
│   ├── __init__.py            ← PROVIDER_REGISTRY dict {provider_key: client_class}
│   ├── base.py                ← NEW: abstract base (below)
│   ├── zerobounce_client.py   ← NEW
│   ├── hunter_client.py       ← NEW
│   ├── reversecontact_client.py ← NEW (token bucket: 15 rps)
│   ├── datagma_client.py      ← NEW
│   ├── pdl_client.py          ← MOVED here from parent dir; logic unchanged
│   ├── fullenrich_client.py   ← NEW (async submit + result parser + signature verify)
│   └── apollo_client.py       ← MOVED here; registry-disabled
```

### 4.1 `providers/base.py`
```python
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum

class ProviderOutcome(str, Enum):
    COMPLETE = "complete"
    PARTIAL = "partial"
    MISS = "miss"
    ERROR = "error"
    PENDING = "pending"        # async providers only

@dataclass
class ProviderResult:
    provider_key: str
    outcome: ProviderOutcome
    fields: dict = field(default_factory=dict)   # canonical subscriber_enrichment field names only
    charged: bool = False
    cost_usd: float = 0.0
    raw_deleted: bool = True                     # must always be True post-extraction
    error_message: str | None = None
    async_reference: str | None = None           # enrichment_id for async providers

class EnrichmentProvider(ABC):
    provider_key: str
    execution_mode: str  # 'sync' | 'async'

    @abstractmethod
    async def enrich(self, email: str, name: str | None, subscriber_id: str) -> ProviderResult: ...

    def classify_completeness(self, fields: dict) -> ProviderOutcome:
        """Shared COMPLETE/PARTIAL/MISS rule — Part 2.3. Implemented ONCE here on the base class."""
```

### 4.2 Orchestrator cascade (core loop — replaces hardcoded pdl→apollo)
```python
async def run_waterfall(subscriber, tenant_id) -> None:
    # Stage 0 — cached 180 days
    validation = await zerobounce.validate(subscriber.email)
    if validation.blocks_enrichment:
        record_gap(subscriber, "email_undeliverable"); return

    merged, provenance, attempted = {}, {}, []
    for provider in load_cascade(tenant_id):                       # registry + tenant_waterfall_config
        if provider.execution_mode == "async":
            if needs_async_sweep(merged, subscriber):              # not COMPLETE and priority >= 40
                ref = await provider.enrich(subscriber.email, subscriber.name, subscriber.id)
                mark_pending(subscriber, provider.provider_key, ref)
            break                                                   # async is always terminal in the sync loop
        result = await provider.enrich(subscriber.email, subscriber.name, subscriber.id)
        attempted.append({"provider": provider.provider_key, "outcome": result.outcome})
        track_cost(provider.provider_key, result)
        merge_fields(merged, provenance, result)                    # Part 5 rules
        if classify(merged) == COMPLETE:
            break
    persist_enrichment(subscriber, merged, provenance, attempted)   # raw JSON already deleted by each client
    if merged: queue_scoring(subscriber)
```
Bulk runs batch per-provider where supported (PDL bulk ≤100, ZeroBounce batch ≤200, FullEnrich bulk ≤100). Hunter/ReverseContact/Datagma are sequential within the worker, respecting their rate limits.

### 4.3 Async webhook receiver — NEW route
```
POST /api/v1/enrichment/webhook/fullenrich
- No JWT (external caller). Auth = SHA1 signature verification against LYCERT_FULLENRICH_API_KEY. Invalid → 401.
- Idempotency: dedupe on (enrichment_id, subscriber_id); replays return 200 without re-processing.
- Flow per result item: extract custom.lycert_subscriber_id → map fields → merge into existing
  subscriber_enrichment (filling gaps only, per Part 5) → clear pending_async_provider →
  update enrichment_jobs counters → queue scoring if anything new arrived.
- Always respond 200 quickly; process via background task (FullEnrich retries on non-2xx).
- Timeout job: nightly task clears pending_async_provider older than 24h, marks outcome 'miss'.
```

---

## PART 5 — FIELD MERGE RULES (Multi-Provider Provenance)

When multiple providers contribute, fields merge under these rules — implemented once in `merge_fields()`:

1. **First-written wins per field** during the cascade (earlier providers are cheaper; later providers only fill gaps) — EXCEPT rule 2.
2. **Education override:** if PDL returns an education array, PDL's `li_education_end_date` and `li_education_institution` OVERWRITE any earlier provider's values (PDL education is the most structured and date-precise; it directly feeds signal C3).
3. **Employment-date completion:** if an earlier provider set `li_current_employer_name` without dates and a later provider returns dates for the SAME employer (case-insensitive name match after stripping legal suffixes like GmbH/Inc/Ltd), merge the dates in. If the later provider names a DIFFERENT employer, the later provider's full employment block replaces the earlier one (real-time providers are fresher) and provenance updates.
4. **Never merge across people:** if a later provider's returned `full_name` has zero token overlap with the subscriber's `name`, discard that provider's result entirely and log `provider_mismatch` — this guards against wrong-person matches corrupting a partial record.
5. Every written field records its provider in `field_provenance`.
6. GDPR exclusions apply at the mapper level for EVERY provider: gender, birth dates, phone numbers, inferred salary, photo/logo URLs are never extracted, regardless of what the provider returns.

---

## PART 6 — SETTINGS UI CHANGES (Dashboard)

Settings > Integrations gains one card per provider (replacing the single PDL card):
- Each card: provider name, status badge (Connected / Not configured / Disabled), masked API key input, "Test connection" button (calls provider with a known-good test input; avoid consuming production credits where the provider offers a sandbox), per-provider month-to-date spend from `enrichment_jobs.per_provider_stats`.
- Waterfall order panel (admin/owner only): drag-to-reorder list writing to `tenant_waterfall_config`; per-provider enable toggle; "Reset to Lycert default" button.
- The existing enrichment budget controls (LYCERT_ENRICHMENT_ARCHITECTURE.md Part 8) now meter ACROSS all providers: `monthly_enrichment_budget` counts total successful paid lookups from any provider.

New env vars (add to `.env.example`, configure in BOTH staging and production):
```
LYCERT_ZEROBOUNCE_API_KEY=
LYCERT_HUNTER_API_KEY=
LYCERT_REVERSECONTACT_API_KEY=
LYCERT_DATAGMA_API_KEY=
LYCERT_FULLENRICH_API_KEY=
# existing: LYCERT_PDL_API_KEY, LYCERT_APOLLO_API_KEY (retained, apollo disabled)
```

---

## PART 7 — GDPR ADDITIONS

Every new provider is a sub-processor. Before each goes live in production:
1. Row added to `sub_processor_registry` (name, purpose, data categories, country, transfer mechanism, DPA link).
2. DPA/SCC documentation collected: ZeroBounce (US), Hunter (France — EU), ReverseContact/Visum (France — EU), Datagma (France — EU; real-time/no-storage model is a documented plus), FullEnrich (France — EU; SOC 2 Type II, GDPR/CCPA per their docs), PDL (US — existing entry).
3. Privacy Policy sub-processor list updated.
4. The 30-day `delete_at` rule applies to fields from every provider identically.

The shift to predominantly French/EU providers materially improves our cross-border transfer posture vs the previous US-only (PDL/Apollo) stack — note this in the next Legitimate Interest Assessment revision.

---

## PART 8 — TESTING & ROLLOUT

### 8.1 Unit tests (fixtures, no live calls) — required before any staging push
- One mapper test file per provider covering: full response, missing education, missing dates, no-match, malformed dates (year-only), wrong-person guard (Part 5 rule 4).
- `test_merge_rules.py`: first-wins, PDL education override, same-employer date completion, different-employer replacement, provenance correctness.
- `test_waterfall_orchestrator.py`: stop-on-complete, continue-on-partial, stage-0 gating, async handoff threshold (priority ≥ 40), budget-pause behavior.
- `test_fullenrich_webhook.py`: valid signature, invalid signature → 401, idempotent replay, 24h timeout cleanup.

### 8.2 THE BENCHMARK (first action after build, BEFORE signing any provider contract)
Create `scripts/benchmark_providers.py`:
- Input: 20-subscriber sample from the design-partner Clay-enriched Excel (ground truth) — emails + known-correct LinkedIn/education/employment.
- Runs each provider's free tier independently (NOT cascaded) against all 20.
- Output table: per provider — hit rate, education coverage, dates coverage, wrong-person count, effective cost/hit.
- Decision rule: reorder `enrichment_providers.default_position` by measured (hit_rate × completeness) ÷ cost. Drop any provider under 15% measured hit rate on our population.
- Record results and the final order in DECISIONS.md.

Free-tier capacity is sufficient for the benchmark: ZeroBounce 100/mo, Hunter 25/mo, ReverseContact trial, Datagma trial credits, PDL 100/mo, FullEnrich 50.

### 8.3 Rollout sequence
1. Migrations 0021–0024 on staging
2. `providers/` refactor (move pdl/apollo, add base + registry) — existing PDL tests must stay green (regression gate)
3. New sync clients + mappers + unit tests
4. Orchestrator cascade rewrite + merge engine
5. FullEnrich client + webhook route + idempotency
6. Settings UI cards + waterfall panel
7. Benchmark script → run → record in DECISIONS.md → set final default order
8. Joshua review on staging → merge to main

---

## PART 9 — WHAT CLAUDE CODE MUST NOT DO

- Do not modify the scoring engine. It is provider-agnostic by design.
- Do not store any raw provider JSON. Extract → discard, every provider, no exceptions.
- Do not request phone data from any provider (Datagma `phoneFull` stays false; FullEnrich `enrich_fields` never includes phones).
- Do not auto-correct subscriber emails from ZeroBounce `did_you_mean` — surface only.
- Do not enable Apollo. It stays in the registry, disabled.
- Do not invent endpoint paths. Where this document says "confirm against docs at implementation time" (FullEnrich exact bulk/reverse-lookup paths), fetch the live docs first; everything else here is the contract.
- Do not run the cascade on emails that failed Stage 0 — there is no override flag, by design.

*End of LYCERT_WATERFALL_ENRICHMENT_V2.md — Version 2.0*
