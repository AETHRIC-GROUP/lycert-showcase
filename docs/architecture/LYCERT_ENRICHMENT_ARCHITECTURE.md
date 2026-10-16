# LYCERT_ENRICHMENT_ARCHITECTURE.md
**Version:** 1.0  
**Date:** June 2026  
**Status:** Authoritative specification for the enrichment engine  
**For Claude Code:** This document defines exactly how to implement `apps/api/services/enrichment/`. Read entirely before touching any enrichment file.

---

## PART 0 — THE MENTAL MODEL

Before building anything, understand the fundamental distinction that drives every architectural decision in this document.

**Pre-enrichment (Free):** Data we can improve, normalize, and cross-reference before spending a single credit. This happens synchronously at import time or on-demand. Uses PDL's free Support APIs (School Cleaner, Location Cleaner, Job Title Enrichment) and Lycert's own Institution Trust database. It requires no credits. It should always run.

**Enrichment (Paid):** The PDL Person Enrichment API call that returns the full professional profile. Costs $0.28 per successful match. Must be triggered deliberately, queued asynchronously, and executed only when the subscriber meets criteria justifying the spend.

**Post-enrichment (Active Intelligence):** The Company Enrichment secondary call triggered by the result of the Person Enrichment. Free for what Lycert already has from Person Enrichment; a small additional cost only when deeper employer intelligence is needed. Feeds the Graduation Transition Engine's offer personalization.

This is Clay's model applied to compliance: Clay does pre-enrichment (data cleaning), enrichment (waterfall lookup), and post-enrichment (outbound actions). Lycert does the same but the "outbound action" is a compliance case or a conversion sequence, not a sales email.

---

## PART 1 — PDL API REFERENCE (The Ground Truth)

### 1.1 Authentication
All PDL endpoints use a **single API key**. The Usage dashboard shows per-endpoint credit consumption, but there is only one key needed to access all endpoints.

```
Header: X-Api-Key: {LYCERT_PDL_API_KEY}
OR
Query param: ?api_key={LYCERT_PDL_API_KEY}
```

Use the header form in all Lycert implementations. Never put the API key in a query string (it appears in server logs).

Rate limits:
- Free tier: 100 requests/minute across all endpoints
- Paid tier: 1,000 requests/minute
- Bulk endpoint: counts as 1 request regardless of batch size (up to 100 records per batch call)

---

### 1.2 ENDPOINT A — Person Enrichment API (PAID — Primary)

**Purpose:** Given a subscriber's email, return their complete professional profile.  
**Cost:** $0.28 per HTTP 200. HTTP 404 = free.  
**Use in Lycert:** Core enrichment for scoring signals C1–C4.

```
GET https://api.peopledatalabs.com/v5/person/enrich
Headers: X-Api-Key: {key}
Params:
  email       = subscriber@example.com       ← PRIMARY input for Lycert
  name        = "John Smith"                 ← improves match accuracy, use if available
  min_likelihood = 4                         ← reject matches below 4/10 confidence (REQUIRED)
  required    = "experience AND education"   ← only return records with both fields (REQUIRED for Lycert)
  pretty      = false                        ← never pretty-print in production
```

**Why `min_likelihood = 4`:** PDL returns a likelihood score 1–10 indicating match confidence. Scores below 4 produce high false positive rates. Matches below 4 are discarded and treated as a 404 for billing purposes (but PDL still charges for the call — the `min_likelihood` param causes PDL to return 404 instead of a low-quality match, so you are not charged).

**Why `required = "experience AND education"`:** If PDL has a profile but it has no employment history and no education history, the data has zero value for Lycert's scoring signals C1–C4. Using `required` makes PDL return 404 (free) instead of billing you for a useless partial record.

**Full response fields Lycert extracts (raw JSON deleted after extraction):**

```json
{
  "status": 200,
  "likelihood": 8,
  "data": {
    "id": "pdl_person_id_string",
    "full_name": "jane smith",
    "first_name": "jane",
    "last_name": "smith",
    "gender": "female",
    "birth_year": 1998,
    
    "linkedin_url": "linkedin.com/in/janesmith",
    "linkedin_username": "janesmith",
    
    "location_name": "berlin, germany",
    "location_country": "germany",
    "location_region": "berlin",
    "location_city": "berlin",
    
    "job_title": "junior architect",
    "job_title_role": "design",
    "job_title_levels": ["entry"],
    "job_company_name": "gensler berlin",
    "job_company_website": "gensler.com",
    "job_company_industry": "architecture & planning",
    "job_company_size": "10001+",
    "job_company_linkedin_url": "linkedin.com/company/gensler",
    "job_company_location_name": "berlin, germany",
    "job_company_location_country": "germany",
    "job_start_date": "2024-02",
    "job_last_updated": "2025-11-01",
    
    "experience": [
      {
        "company": {
          "name": "gensler berlin",
          "website": "gensler.com",
          "size": "10001+",
          "industry": "architecture & planning",
          "linkedin_url": "linkedin.com/company/gensler",
          "location": {"name": "berlin, germany", "country": "germany"}
        },
        "title": {"name": "junior architect", "role": "design", "levels": ["entry"]},
        "start_date": "2024-02",
        "end_date": null,
        "is_primary": true
      },
      {
        "company": {"name": "university of stuttgart"},
        "title": {"name": "student worker"},
        "start_date": "2022-06",
        "end_date": "2024-01",
        "is_primary": false
      }
    ],
    
    "education": [
      {
        "school": {
          "name": "university of stuttgart",
          "type": "university",
          "linkedin_url": "linkedin.com/school/university-of-stuttgart"
        },
        "degrees": ["bachelor of architecture"],
        "majors": ["architecture"],
        "start_date": "2018",
        "end_date": "2023",
        "gpa": null
      }
    ],
    
    "skills": ["revit", "autocad", "3d visualization", "the partner's visualizer", "the partner's renderer"],
    
    "inferred_salary": "$45,000-$55,000"
  }
}
```

**Fields Lycert stores in `subscriber_enrichment` table (after raw JSON deletion):**

| PDL field | → `subscriber_enrichment` column | Used by signal |
|---|---|---|
| `data.linkedin_url` | `linkedin_profile_url` | Reference |
| `data.job_title` | `li_job_title` | C2 |
| `data.job_title_levels` | `li_job_title_levels` (jsonb) | C2 |
| `data.job_company_name` | `li_current_employer_name` | C1, C4 |
| `data.job_company_website` | `li_current_employer_domain` | C4 |
| `data.job_company_linkedin_url` | `li_current_employer_linkedin_url` | Reference |
| `data.job_company_size` | `li_employer_size` | Conversion engine |
| `data.job_company_industry` | `li_employer_industry` | C4, Conversion engine |
| `data.job_start_date` | `li_job_start_date` | C1 |
| `data.experience[0].end_date` (primary) | `li_job_end_date` | C1 (null = currently employed) |
| `data.education[-1].end_date` (latest) | `li_education_end_date` | C3 |
| `data.education[-1].school.name` | `li_education_institution` | Reference |
| `data.location_country` | `li_country` | B3 cross-reference |
| `data.location_region` | `li_state` | Reference |
| `data.location_city` | `li_city` | Reference |
| `likelihood` | `pdl_likelihood_score` | Data confidence |
| `data.skills` | `li_skills` (jsonb array, first 10 only) | Future signals |

**Fields explicitly NOT stored:**
- `data.id` (PDL's internal ID — no need to store)
- `data.birth_year` (not used in scoring; storing would be GDPR over-collection)
- `data.gender` (never stored — discrimination risk)
- `data.inferred_salary` (not needed for compliance scoring)
- `data.phones`, `data.mobile_phones` (not needed, GDPR sensitive)
- Full `experience` array beyond primary job (only the primary job's fields extracted)
- Full `education` array beyond latest entry (only latest end_date extracted)

**Education end_date extraction logic:**

```python
def extract_education_end_date(education_array: list) -> date | None:
    """
    Returns the latest education end_date across all entries.
    Handles partial dates ("2023" → 2023-12-31 for conservative scoring).
    Returns None if no education entries have end dates.
    """
    dates = []
    for entry in education_array:
        end = entry.get("end_date")
        if end:
            if len(end) == 4:  # year only: "2023"
                dates.append(date(int(end), 12, 31))
            elif len(end) == 7:  # year-month: "2023-06"
                year, month = end.split("-")
                dates.append(date(int(year), int(month), 28))
            # Full dates unlikely from PDL but handle if present
    return max(dates) if dates else None
```

---

### 1.3 ENDPOINT B — Bulk Person Enrichment API (PAID — Batch Mode)

**Purpose:** Enrich up to 100 subscribers in a single HTTP call. Same cost per match as single enrichment.  
**Use in Lycert:** All scheduled batch enrichment runs (nightly lifecycle job, re-enrichment cycles).  
**Benefit:** Counts as 1 API request against rate limits regardless of batch size.

```
POST https://api.peopledatalabs.com/v5/person/bulk
Headers: X-Api-Key: {key}, Content-Type: application/json
Body:
{
  "requests": [
    {
      "metadata": {"lycert_subscriber_id": "uuid-here"},
      "params": {
        "email": "subscriber1@example.com",
        "name": "Jane Smith",
        "min_likelihood": 4,
        "required": "experience AND education"
      }
    },
    {
      "metadata": {"lycert_subscriber_id": "uuid-here-2"},
      "params": {
        "email": "subscriber2@example.com",
        "min_likelihood": 4,
        "required": "experience AND education"
      }
    }
  ]
}
```

Response: array of individual enrichment results in the same order as requests. Each has its own `status` (200 or 404) and `metadata` passthrough (use to match results back to subscriber IDs).

**Implementation rule:** Always use bulk endpoint for any batch of 2+ subscribers. Never loop single-enrichment calls in sequence.

---

### 1.4 ENDPOINT C — Person Identify API (PAID — Fallback)

**Purpose:** Fuzzy multi-candidate lookup when email returns 404. Input: name + institution or name + location.  
**Cost:** Same credit cost as Person Enrichment per matched record returned.  
**Use in Lycert:** Tertiary fallback only. Triggered when: Person Enrichment returns 404 AND subscriber has both `name` and `institution_name` fields populated.

```
GET https://api.peopledatalabs.com/v5/person/identify
Headers: X-Api-Key: {key}
Params:
  name        = "Jane Smith"
  company     = "University of Stuttgart"   ← use institution_name here
  location    = "Germany"
  min_likelihood = 6                        ← higher threshold for fuzzy match
```

Returns array of up to 5 candidate profiles. Lycert takes the top result only if likelihood >= 6. Otherwise logs as `enrichment_provider = null`.

**Important:** Identify API uses different credit accounting than Enrichment. Confirm with PDL's pricing page before using at scale. Only use when email enrichment fails and the subscriber has high compliance risk (Tier 1 candidates only).

---

### 1.5 ENDPOINT D — Person Changelog API (PAID — Change Detection)

**Purpose:** Returns profiles that have changed since a given date.  
**Cost:** Credits consumed per changed profile returned.  
**Use in Lycert:** Phase 5 optimization — instead of re-enriching all subscribers every 90 days, query changelog first to find only subscribers whose profiles have actually changed.

```
GET https://api.peopledatalabs.com/v5/person/changelog
Headers: X-Api-Key: {key}
Params:
  pdl_id      = "stored_pdl_id"
  from_date   = "2026-01-01"
```

**Implementation note:** Requires storing `pdl_id` from the original enrichment response. Add `pdl_id` column to `subscriber_enrichment` table. Do NOT implement in Phase 1 or 2. Add in Phase 5 as a cost optimization.

---

### 1.6 ENDPOINT E — School Cleaner API (FREE — Pre-enrichment)

**Purpose:** Normalizes a raw institution name string to PDL's canonical school record.  
**Cost:** Free. Included with all plans.  
**Use in Lycert:** Pre-enrichment normalization of `institution_name` field at import time and verification submission time.

```
GET https://api.peopledatalabs.com/v5/school/clean
Headers: X-Api-Key: {key}
Params:
  name = "MIT"                  ← input: raw institution name from subscriber
  
Response:
{
  "status": 200,
  "data": {
    "name": "massachusetts institute of technology",
    "display_name": "Massachusetts Institute of Technology",
    "linkedin_url": "linkedin.com/school/mit",
    "website": "mit.edu",
    "domain": "mit.edu",
    "type": "university",
    "country": "united states",
    "region": "massachusetts",
    "city": "cambridge"
  }
}
```

**What Lycert does with this response:**
1. Store `display_name` as `institution_name_normalized` in `subscribers` table (alongside original `institution_name` which is never overwritten)
2. Store `domain` as `institution_domain_verified` — use this for B1 signal email domain cross-check
3. Store `country` as `institution_country_verified` — use for B3 signal country mismatch
4. Look up the `domain` in `institutions` table — if found, load trust tier; if not found, create a new `institutions` record with `source = 'pdl_school_cleaner'`
5. If School Cleaner returns 404 (institution not recognized by PDL), set `institution_pdl_verified = false` — this is itself a weak suspicious signal

**Implementation timing:** Call School Cleaner at CSV import time and at hosted verification form submission. Never call it on demand from a user click — it should be automatic and invisible.

---

### 1.7 ENDPOINT F — Location Cleaner API (FREE — Pre-enrichment)

**Purpose:** Normalizes a raw location string to a canonical country/region/city.  
**Cost:** Free. Included with all plans.  
**Use in Lycert:** Pre-enrichment normalization of `account_location` and `institution_location` at import time.

```
GET https://api.peopledatalabs.com/v5/location/clean
Headers: X-Api-Key: {key}
Params:
  location = "Germany, Baden-Württemberg"
  
Response:
{
  "status": 200,
  "data": {
    "name": "karlsruhe, germany",
    "locality": "karlsruhe",
    "region": "baden-württemberg",
    "country": "germany",
    "continent": "europe"
  }
}
```

**What Lycert does with this response:**
1. Store `country` as `account_country_normalized` alongside original `account_country`
2. Store `country` as `institution_country_normalized` when called on `institution_location`
3. Use `account_country_normalized` and `institution_country_normalized` for signal B3 (country mismatch) — this replaces the current COUNTRY_ALIASES dict in the CEDS engine entirely

**This eliminates one of the most common false positives in the CEDS model:** The original B3 signal used a hand-maintained `COUNTRY_ALIASES` dict. "USA", "US", "United States of America" were all manual mappings. Location Cleaner handles this automatically, handles every country, handles typos, and handles regional language variations ("Allemagne" → "germany").

---

### 1.8 ENDPOINT G — Job Title Enrichment API (FREE — Pre-enrichment)

**Purpose:** Takes a raw job title string, returns canonical job title + 5 similar titles + top 5 related skills.  
**Cost:** Free. Included with all plans.  
**Use in Lycert:** Pre-enrichment job title normalization for the Graduation Transition Engine's offer personalization. NOT used in scoring — scoring uses PDL's already-normalized `job_title_levels` from Person Enrichment.

```
GET https://api.peopledatalabs.com/v5/job_title/enrich
Headers: X-Api-Key: {key}
Params:
  job_title = "junior archviz artist"
  
Response:
{
  "status": 200,
  "data": {
    "cleaned_job_title": "junior architectural visualization artist",
    "similar_job_titles": [
      "3d visualization artist",
      "architectural renderer",
      "cgi artist",
      "visualization specialist",
      "3d artist"
    ],
    "skills": ["3ds max", "the partner's renderer", "the partner's visualizer", "lumion", "corona renderer"]
  }
}
```

**What Lycert does with this response:**
Used exclusively in the email personalization layer (Phase 2). When composing a graduation transition email, the job title normalization enriches the Claude prompt context: instead of "junior archviz artist" the prompt receives "Architectural Visualization Artist" — a more meaningful term for personalizing the email copy.

---

### 1.9 ENDPOINT H — Company Enrichment API (PAID — Secondary Enrichment)

**Purpose:** Given an employer's domain or company name, return full company profile.  
**Cost:** Separate credits from Person Enrichment (check current PDL pricing — typically lower than person credits).  
**Use in Lycert:** Secondary enrichment call triggered for high-value subscribers (Tier 1 or AEC Professional Confirmed = true) after person enrichment. Provides employer size, headcount, funding status, and industry for conversion offer personalization.

```
GET https://api.peopledatalabs.com/v5/company/enrich
Headers: X-Api-Key: {key}
Params:
  website = "gensler.com"       ← from li_current_employer_domain in subscriber_enrichment
  
Response (key fields):
{
  "status": 200,
  "data": {
    "name": "gensler",
    "website": "gensler.com",
    "size": "10001+",
    "employee_count": 6000,
    "industry": "architecture & planning",
    "founded": 1965,
    "location": {"country": "united states", "city": "san francisco"},
    "linkedin_url": "linkedin.com/company/gensler",
    "linkedin_follower_count": 450000,
    "tags": ["aec", "architecture", "interior design"],
    "total_funding_raised": null
  }
}
```

**What Lycert stores (new table: `subscriber_employer_enrichment`):**

| Field | Column | Use |
|---|---|---|
| `data.name` | `employer_name_canonical` | Display |
| `data.size` | `employer_size_band` | Conversion offer selection |
| `data.employee_count` | `employer_headcount` | Conversion offer selection |
| `data.industry` | `employer_industry` | C4 signal, conversion |
| `data.founded` | `employer_founded_year` | Startup detection (future) |
| `data.total_funding_raised` | `employer_total_funding` | Nonprofit/startup vertical (future) |

**Trigger rule:** Only call Company Enrichment when ALL of these are true:
1. Person Enrichment returned likelihood >= 6
2. `li_current_employer_domain` is populated and is not an academic domain
3. Subscriber is in `lifecycle_stage = 'approaching_graduation'` OR `post_graduation_unverified` OR scored Tier 1/2

Do NOT call Company Enrichment for every subscriber. It is a targeted enrichment for the conversion engine, not a baseline signal.

---

## PART 2 — THE ENRICHMENT PIPELINE (Full Flow)

### 2.1 Visual Overview

```
SUBSCRIBER RECORD CREATED (via CSV import or hosted verification)
            │
            ▼
    ┌─────────────────────┐
    │   PRE-ENRICHMENT    │  ← FREE. Always runs. Synchronous.
    │   (Free APIs)       │
    └─────────────────────┘
            │
    ┌───────┴────────────────────────────────────┐
    │  1. School Cleaner API                     │
    │     Input: institution_name                │
    │     Output: normalized name, domain,       │
    │             country, institution type      │
    │     → Updates: institution_name_normalized,│
    │       institution_domain_verified,         │
    │       institution_country_normalized,      │
    │       institution_pdl_verified             │
    │     → Upserts: institutions table          │
    └───────────────────────────────────────────-┘
            │
    ┌───────┴────────────────────────────────────┐
    │  2. Location Cleaner API (×2)              │
    │     Input A: account_location              │
    │     Input B: institution_location          │
    │     Output: canonical country for each     │
    │     → Updates: account_country_normalized, │
    │       institution_country_normalized       │
    │     → Replaces COUNTRY_ALIASES dict in B3  │
    └────────────────────────────────────────────┘
            │
    ┌───────┴────────────────────────────────────┐
    │  3. Email Domain Classification            │
    │     (Internal, no API needed)              │
    │     Input: subscriber email                │
    │     Logic: check domain against:           │
    │       - institution_domain_verified        │
    │       - PERSONAL_DOMAINS constant          │
    │       - academic TLD list (.edu, .ac.uk,   │
    │         .uni-*.de, etc.)                   │
    │       - disposable email DB                │
    │     Output: domain_type enum:              │
    │       'academic' / 'personal' /            │
    │       'corporate' / 'disposable'           │
    │     → Updates: subscribers.email_domain_type│
    └────────────────────────────────────────────┘
            │
    ┌───────┴────────────────────────────────────┐
    │  4. Lifecycle Stage Assignment             │
    │     Input: stated_graduation_date vs today │
    │     Logic: see LYCERT_ARCHITECTURE.md      │
    │       section 2.3 lifecycle stage engine   │
    │     → Updates: subscribers.lifecycle_stage │
    └────────────────────────────────────────────┘
            │
            ▼
    ┌─────────────────────┐
    │ ENRICHMENT TRIGGER  │  ← Decision gate: does this subscriber
    │ EVALUATION          │    qualify for paid enrichment now?
    └─────────────────────┘
            │
    ┌───────┴────────────────────────────────────┐
    │  ENRICHMENT CRITERIA (ANY of these):       │
    │  • lifecycle_stage = approaching_graduation│
    │    (graduation within 90 days)             │
    │  • lifecycle_stage = post_graduation_      │
    │    unverified (graduation date passed)     │
    │  • Last enrichment > 90 days ago AND       │
    │    open compliance case exists             │
    │  • Manual trigger by reviewer in dashboard │
    │  • Bulk trigger by manager (Enrich All)    │
    │                                            │
    │  NOT enriched if:                          │
    │  • lifecycle_stage = active_student AND    │
    │    graduation > 90 days away               │
    │  • Already enriched < 30 days ago          │
    │  • lifecycle_stage = converted OR churned  │
    └────────────────────────────────────────────┘
            │
       [Qualifies]                [Doesn't qualify]
            │                           │
            ▼                           ▼
    ┌─────────────────────┐      subscribers.enrichment_
    │  ENRICHMENT QUEUE   │      deferred = true
    │  (Upstash Redis)    │      (re-evaluated nightly)
    └─────────────────────┘
            │
            ▼
    ┌─────────────────────────────────────────────┐
    │  ENRICHMENT WORKER (async, Railway)         │
    │                                             │
    │  Step 1: Batch by tenant, up to 100/call    │
    │  Step 2: Bulk Person Enrichment API call    │
    │          Required: experience AND education │
    │          min_likelihood: 4                  │
    │                                             │
    │  Result A: HTTP 200, likelihood >= 4        │
    │  → Extract fields to subscriber_enrichment  │
    │  → Delete raw JSON immediately              │
    │  → Set delete_at = now + 30 days            │
    │  → Queue scoring run for this subscriber    │
    │                                             │
    │  Result B: HTTP 200, likelihood < 4         │
    │  → Treat as miss (don't store low quality)  │
    │  → Log provider_miss_reason = 'low_quality' │
    │  → Skip to Fallback                         │
    │                                             │
    │  Result C: HTTP 404                         │
    │  → No charge. Log as pdl_miss.              │
    │  → Skip to Fallback                         │
    └─────────────────────────────────────────────┘
            │
    ┌───────┴────────────────────────────────────┐
    │  FALLBACK: Apollo Person Enrichment         │
    │  (only on PDL miss)                        │
    │                                             │
    │  POST https://api.apollo.io/v1/people/match│
    │  Body: {email, name}                       │
    │                                             │
    │  Apollo returns: job_title, seniority,     │
    │  current employer, employment history,     │
    │  location, LinkedIn URL                    │
    │                                             │
    │  NOTE: Apollo does NOT return education    │
    │  history. C3 signal = data_gap when        │
    │  Apollo-only match.                        │
    │                                             │
    │  On Apollo hit: populate what's available  │
    │  Mark enrichment_provider = 'apollo'       │
    │  Mark data_gaps includes 'education_history'│
    └────────────────────────────────────────────┘
            │
    ┌───────┴────────────────────────────────────┐
    │  TERTIARY FALLBACK: Person Identify        │
    │  (only when BOTH PDL and Apollo miss AND   │
    │   subscriber is Tier 1 candidate based     │
    │   on Tier A signals alone)                 │
    │                                             │
    │  GET /v5/person/identify                   │
    │  Params: name + institution (as company)  │
    │  min_likelihood = 6 (higher threshold)    │
    │                                             │
    │  On hit: same extraction as Person Enrich  │
    │  Mark enrichment_provider = 'pdl_identify' │
    └────────────────────────────────────────────┘
            │
    ┌───────┴────────────────────────────────────┐
    │  SECONDARY ENRICHMENT: Company Enrichment  │
    │  (only when ALL three conditions met):     │
    │  1. Person enrichment succeeded            │
    │  2. li_current_employer_domain is populated│
    │     and not an academic domain             │
    │  3. Subscriber is Tier 1 or 2, or          │
    │     AEC Professional Confirmed = true      │
    │                                             │
    │  GET /v5/company/enrich                    │
    │  Param: website = li_current_employer_domain│
    │                                             │
    │  On hit: write to subscriber_employer_enrich│
    │  Used by: conversion offer selection logic │
    └────────────────────────────────────────────┘
            │
            ▼
    ┌─────────────────────┐
    │  SCORING TRIGGER    │  ← Auto-queue scoring run after enrichment
    └─────────────────────┘
            │
            ▼
    ┌─────────────────────┐
    │  SCORING ENGINE     │  ← Reads subscriber + enrichment → produces score
    └─────────────────────┘
            │
            ▼
    ┌─────────────────────────────────────────────┐
    │  POST-SCORING ACTIONS (automatic)           │
    │                                             │
    │  If Tier 1 or 2: create compliance case     │
    │  If approaching_graduation: queue T-90 email│
    │  If AEC Prof Confirmed: flag for sales team │
    │  All: update subscribers.lifecycle_stage    │
    └─────────────────────────────────────────────┘
```

---

## PART 3 — PRE-ENRICHMENT DATA IMPROVEMENT (The Free Intelligence Layer)

This is what Clay does before enrichment that most teams skip. In Lycert, pre-enrichment runs automatically at import time and makes the dashboard immediately more useful even before a single paid enrichment happens.

### 3.1 What the Dashboard Shows Before Paid Enrichment

When a client imports 10,000 subscribers and has not yet triggered enrichment, the dashboard should not be empty and dumb. Pre-enrichment gives it intelligence.

**Before any paid enrichment, Lycert's dashboard can display:**
- `institution_name_normalized` — "MIT" is now "Massachusetts Institute of Technology"
- `institution_domain_verified` — "mit.edu" — confirmed by PDL School Cleaner
- `institution_country_normalized` — "united states"
- `institution_pdl_verified` — true/false (School Cleaner recognized it or not)
- `institution_trust_tier` — from Lycert's institutions table: high/medium/low/suspicious
- `account_country_normalized` — "brazil" not "BRASIL"
- `email_domain_type` — 'academic' / 'personal' / 'corporate' / 'disposable'
- `lifecycle_stage` — already assigned from graduation date alone
- Tier A signals already scored (A1, A2, A3, A4 all come from billing data — no enrichment needed)
- B1, B2, B3 signals already scored (email domain, institution name, country mismatch)

This means the scoring engine can already produce **partial scores** before enrichment. A subscriber who graduated 2 years ago, uses a Gmail address, and listed their account name as their institution (B2 fires) already has a score of 40–50 from Tier A and B signals alone. They are already Tier 2 without any paid enrichment.

**This is the key insight that reduces enrichment costs:** Pre-enrichment scoring tells Lycert which subscribers are worth spending $0.28 on. Subscribers who are already Tier 2 from billing signals alone are the ones most worth enriching. Subscribers who are Clean from billing signals alone may not need enrichment at all.

### 3.2 Pre-enrichment Score → Enrichment Priority Queue

```python
def compute_enrichment_priority(subscriber) -> int:
    """
    Returns priority score 0-100. Higher = enrich sooner.
    Called after pre-enrichment completes. 
    Used to sort the enrichment queue.
    """
    score = 0
    
    # Graduation timing (most important)
    days_since_grad = (today - subscriber.stated_graduation_date).days
    if days_since_grad > 365:
        score += 40
    elif days_since_grad > 180:
        score += 30
    elif days_since_grad > 0:
        score += 20
    elif days_since_grad > -90:  # graduating soon
        score += 15
    
    # Email domain (strong signal)
    if subscriber.email_domain_type == 'corporate':
        score += 25
    elif subscriber.email_domain_type == 'personal':
        score += 10
    elif subscriber.email_domain_type == 'disposable':
        score += 20
    
    # Institution trust
    if subscriber.institution_trust_tier == 'suspicious':
        score += 20
    elif not subscriber.institution_pdl_verified:
        score += 10
    elif subscriber.institution_trust_tier == 'low':
        score += 5
    
    # Auto-renew signal
    if subscriber.auto_renew:
        score += 5
    
    return min(score, 100)
```

---

## PART 4 — DATABASE ADDITIONS REQUIRED

The following columns and tables need to be added to support this enrichment architecture. These are additions to the schema defined in LYCERT_ARCHITECTURE.md.

### 4.1 New columns on `subscribers` table

```sql
-- Pre-enrichment columns (populated by free API calls at import time)
ALTER TABLE subscribers ADD COLUMN institution_name_normalized text;
ALTER TABLE subscribers ADD COLUMN institution_domain_verified text;
ALTER TABLE subscribers ADD COLUMN institution_country_normalized text;
ALTER TABLE subscribers ADD COLUMN institution_pdl_verified boolean DEFAULT false;
ALTER TABLE subscribers ADD COLUMN institution_trust_tier text; -- 'high'/'medium'/'low'/'suspicious'/null
ALTER TABLE subscribers ADD COLUMN account_country_normalized text;
ALTER TABLE subscribers ADD COLUMN email_domain_type text; -- 'academic'/'personal'/'corporate'/'disposable'
ALTER TABLE subscribers ADD COLUMN enrichment_priority integer DEFAULT 0;
ALTER TABLE subscribers ADD COLUMN enrichment_deferred boolean DEFAULT false;
```

### 4.2 New columns on `subscriber_enrichment` table

```sql
-- Additional PDL fields
ALTER TABLE subscriber_enrichment ADD COLUMN pdl_person_id text; -- for changelog API (Phase 5)
ALTER TABLE subscriber_enrichment ADD COLUMN pdl_likelihood_score integer;
ALTER TABLE subscriber_enrichment ADD COLUMN li_job_title_levels jsonb; -- e.g. ["senior", "manager"]
ALTER TABLE subscriber_enrichment ADD COLUMN li_employer_size text; -- e.g. "10001+"
ALTER TABLE subscriber_enrichment ADD COLUMN li_employer_industry text;
ALTER TABLE subscriber_enrichment ADD COLUMN li_skills jsonb; -- first 10 skills from PDL
ALTER TABLE subscriber_enrichment ADD COLUMN provider_miss_reason text; -- 'low_quality'/'no_match'/null
```

### 4.3 New table: `subscriber_employer_enrichment`

```sql
CREATE TABLE subscriber_employer_enrichment (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subscriber_id uuid REFERENCES subscribers(id) ON DELETE CASCADE,
    tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
    employer_name_canonical text,
    employer_size_band text,          -- PDL size band: "1-10", "11-50", etc.
    employer_headcount integer,       -- exact count if available
    employer_industry text,
    employer_founded_year integer,
    employer_total_funding bigint,    -- in USD, for startup vertical
    employer_pdl_id text,
    enriched_at timestamptz NOT NULL DEFAULT now(),
    delete_at timestamptz NOT NULL,   -- 30-day deletion same as subscriber_enrichment
    UNIQUE(subscriber_id)             -- one employer enrichment per subscriber
);

ALTER TABLE subscriber_employer_enrichment ENABLE ROW LEVEL SECURITY;
CREATE POLICY "employer_enrich_tenant_isolation" ON subscriber_employer_enrichment
    FOR ALL TO authenticated
    USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);
```

### 4.4 New table: `enrichment_jobs`

Tracks all enrichment operations for monitoring, cost accounting, and retry logic.

```sql
CREATE TABLE enrichment_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
    job_type text NOT NULL,           -- 'single' / 'batch' / 'scheduled' / 'manual'
    trigger_reason text,              -- 'lifecycle_trigger' / 'manual' / 'scheduled' / 'onboarding'
    status text NOT NULL DEFAULT 'queued', -- 'queued'/'running'/'completed'/'failed'
    subscriber_ids jsonb,             -- array of subscriber UUIDs in this job
    total_count integer,
    success_count integer DEFAULT 0,
    miss_count integer DEFAULT 0,     -- 404 responses (free)
    low_quality_count integer DEFAULT 0,
    error_count integer DEFAULT 0,
    pdl_credits_consumed integer DEFAULT 0,
    apollo_credits_consumed integer DEFAULT 0,
    estimated_cost_usd numeric(10,4),
    started_at timestamptz,
    completed_at timestamptz,
    error_message text,
    created_at timestamptz NOT NULL DEFAULT now()
);
```

---

## PART 5 — THE ENRICHMENT SERVICE — FILE STRUCTURE

```
apps/api/services/enrichment/
├── __init__.py
├── orchestrator.py          ← Main entry point. Called by routes and workers.
├── pre_enrichment.py        ← Free API calls: School Cleaner, Location Cleaner, email classification
├── pdl_client.py            ← PDL API wrapper (all endpoints)
├── apollo_client.py         ← Apollo API wrapper (fallback)
├── field_mapper.py          ← Maps raw PDL/Apollo JSON → Lycert schema fields
├── credit_tracker.py        ← Logs enrichment costs to enrichment_jobs table
├── priority_queue.py        ← Computes enrichment_priority, manages Redis queue
└── company_enrichment.py    ← Secondary company enrichment logic
```

---

## PART 6 — EXACT API CALL IMPLEMENTATIONS

### 6.1 `pdl_client.py` — Complete Implementation Spec

```python
# apps/api/services/enrichment/pdl_client.py

import httpx
import os
from typing import Optional
from models.enrichment import PDLPersonResult, PDLCompanyResult

PDL_BASE_URL = "https://api.peopledatalabs.com/v5"
PDL_API_KEY = os.environ["LYCERT_PDL_API_KEY"]  # Never hardcode

HEADERS = {
    "X-Api-Key": PDL_API_KEY,
    "Content-Type": "application/json"
}

# --- Person Enrichment (single) ---
async def enrich_person(
    email: str,
    name: Optional[str] = None,
    min_likelihood: int = 4
) -> PDLPersonResult:
    """
    Single person enrichment. Use only for manual/on-demand triggers.
    For batch operations, use enrich_person_bulk().
    """
    params = {
        "email": email,
        "min_likelihood": min_likelihood,
        "required": "experience AND education",
        "pretty": "false"
    }
    if name:
        params["name"] = name
    
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get(
            f"{PDL_BASE_URL}/person/enrich",
            headers=HEADERS,
            params=params
        )
    
    if response.status_code == 200:
        data = response.json()
        return PDLPersonResult(
            status=200,
            likelihood=data["likelihood"],
            data=data["data"],
            charged=True
        )
    elif response.status_code == 404:
        return PDLPersonResult(status=404, charged=False)
    else:
        # 400, 401, 402, 429, 500 etc.
        raise PDLAPIError(
            status_code=response.status_code,
            message=response.json().get("error", {}).get("message", "Unknown PDL error")
        )


# --- Bulk Person Enrichment ---
async def enrich_person_bulk(
    requests: list[dict],  # list of {"subscriber_id": uuid, "email": str, "name": str|None}
    min_likelihood: int = 4
) -> list[PDLPersonResult]:
    """
    Enriches up to 100 subscribers in a single API call.
    Returns results in same order as input.
    Always use this for batch operations.
    """
    bulk_requests = []
    for req in requests:
        params = {
            "email": req["email"],
            "min_likelihood": min_likelihood,
            "required": "experience AND education"
        }
        if req.get("name"):
            params["name"] = req["name"]
        
        bulk_requests.append({
            "metadata": {"lycert_subscriber_id": str(req["subscriber_id"])},
            "params": params
        })
    
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            f"{PDL_BASE_URL}/person/bulk",
            headers=HEADERS,
            json={"requests": bulk_requests}
        )
    
    if response.status_code != 200:
        raise PDLAPIError(response.status_code, "Bulk enrichment request failed")
    
    results = []
    for item in response.json():
        subscriber_id = item["metadata"]["lycert_subscriber_id"]
        if item["status"] == 200:
            results.append(PDLPersonResult(
                status=200,
                likelihood=item["likelihood"],
                data=item["data"],
                subscriber_id=subscriber_id,
                charged=True
            ))
        else:
            results.append(PDLPersonResult(
                status=404,
                subscriber_id=subscriber_id,
                charged=False
            ))
    
    return results


# --- School Cleaner (free) ---
async def clean_school(institution_name: str) -> dict | None:
    """
    Returns normalized school data or None if not recognized.
    Never charged. Use at import time.
    """
    async with httpx.AsyncClient(timeout=5.0) as client:
        response = await client.get(
            f"{PDL_BASE_URL}/school/clean",
            headers=HEADERS,
            params={"name": institution_name}
        )
    
    if response.status_code == 200:
        return response.json()["data"]
    return None  # 404 = school not in PDL database


# --- Location Cleaner (free) ---
async def clean_location(location_string: str) -> dict | None:
    """
    Returns normalized location data or None if not parseable.
    Never charged. Use at import time.
    """
    async with httpx.AsyncClient(timeout=5.0) as client:
        response = await client.get(
            f"{PDL_BASE_URL}/location/clean",
            headers=HEADERS,
            params={"location": location_string}
        )
    
    if response.status_code == 200:
        return response.json()["data"]
    return None


# --- Company Enrichment ---
async def enrich_company(domain: str) -> dict | None:
    """
    Returns company profile for a given domain.
    Only call for Tier 1/2 subscribers or AEC Professional Confirmed.
    """
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get(
            f"{PDL_BASE_URL}/company/enrich",
            headers=HEADERS,
            params={"website": domain}
        )
    
    if response.status_code == 200:
        return response.json()["data"]
    return None
```

---

### 6.2 `field_mapper.py` — PDL JSON → Lycert Schema

```python
# apps/api/services/enrichment/field_mapper.py

from datetime import date
from typing import Optional

def map_pdl_person_to_enrichment_record(
    pdl_data: dict,
    likelihood: int,
    subscriber_id: str,
    tenant_id: str
) -> dict:
    """
    Maps the raw PDL person.data dict to Lycert's subscriber_enrichment schema.
    Raw PDL data is NOT stored. Only these extracted fields are persisted.
    """
    
    # Extract primary experience (is_primary = true, or first entry)
    primary_job = _get_primary_job(pdl_data.get("experience", []))
    
    # Extract latest education end date
    edu_end_date = _extract_education_end_date(pdl_data.get("education", []))
    
    # Extract latest education institution
    edu_institution = _extract_latest_education_institution(pdl_data.get("education", []))
    
    return {
        "subscriber_id": subscriber_id,
        "tenant_id": tenant_id,
        "pdl_person_id": pdl_data.get("id"),
        "pdl_likelihood_score": likelihood,
        "linkedin_profile_url": pdl_data.get("linkedin_url"),
        "li_job_title": pdl_data.get("job_title"),
        "li_job_title_levels": pdl_data.get("job_title_levels"),  # jsonb
        "li_current_employer_name": pdl_data.get("job_company_name"),
        "li_current_employer_domain": pdl_data.get("job_company_website"),
        "li_current_employer_linkedin_url": pdl_data.get("job_company_linkedin_url"),
        "li_employer_size": pdl_data.get("job_company_size"),
        "li_employer_industry": pdl_data.get("job_company_industry"),
        "li_job_start_date": _parse_pdl_date(pdl_data.get("job_start_date")),
        "li_job_end_date": _parse_pdl_date(primary_job.get("end_date")) if primary_job else None,
        "li_education_institution": edu_institution,
        "li_education_end_date": edu_end_date,
        "li_country": pdl_data.get("location_country"),
        "li_state": pdl_data.get("location_region"),
        "li_city": pdl_data.get("location_city"),
        "li_skills": pdl_data.get("skills", [])[:10],  # first 10 only
        "enrichment_provider": "pdl",
        "enriched_at": "now()",
        "delete_at": "now() + interval '30 days'"
    }


def _get_primary_job(experience: list) -> dict | None:
    """Returns the primary (current) job from experience array."""
    for exp in experience:
        if exp.get("is_primary"):
            return exp
    return experience[0] if experience else None


def _extract_education_end_date(education: list) -> date | None:
    """Returns the latest education end date across all entries."""
    dates = []
    for entry in education:
        end = entry.get("end_date")
        if end:
            try:
                if len(end) == 4:
                    dates.append(date(int(end), 12, 31))
                elif len(end) == 7:
                    year, month = end.split("-")
                    dates.append(date(int(year), int(month), 28))
            except (ValueError, TypeError):
                pass
    return max(dates) if dates else None


def _extract_latest_education_institution(education: list) -> str | None:
    """Returns the institution name from the most recent education entry."""
    if not education:
        return None
    sorted_edu = sorted(
        [e for e in education if e.get("end_date")],
        key=lambda x: x.get("end_date", ""),
        reverse=True
    )
    if sorted_edu:
        return sorted_edu[0].get("school", {}).get("name")
    return education[0].get("school", {}).get("name") if education else None


def _parse_pdl_date(date_str: str | None) -> date | None:
    """Parse PDL date format (YYYY or YYYY-MM) to Python date."""
    if not date_str:
        return None
    try:
        if len(date_str) == 4:
            return date(int(date_str), 1, 1)
        elif len(date_str) == 7:
            year, month = date_str.split("-")
            return date(int(year), int(month), 1)
        elif len(date_str) == 10:
            return date.fromisoformat(date_str)
    except (ValueError, TypeError):
        return None
    return None
```

---

## PART 7 — FASTAPI ROUTE STRUCTURE FOR ENRICHMENT

```
apps/api/routers/enrichment.py

POST   /api/v1/subscribers/{subscriber_id}/enrich
       ← Manual single enrichment trigger from dashboard
       ← Auth: manager/admin/owner only
       ← Returns: enrichment job ID (async, not the result)

POST   /api/v1/tenants/{tenant_id}/enrich/batch
       ← Triggers enrichment for all qualifying subscribers
       ← Auth: manager/admin/owner only
       ← Body: {"force": false} — force=true overrides 30-day cache
       ← Returns: enrichment job ID

GET    /api/v1/enrichment/jobs/{job_id}
       ← Polls enrichment job status and summary
       ← Auth: any authenticated user in tenant

POST   /api/v1/subscribers/{subscriber_id}/pre-enrich
       ← Runs free pre-enrichment APIs only (no credit cost)
       ← Auth: manager/admin/owner only
       ← Returns: updated subscriber record synchronously

GET    /api/v1/enrichment/coverage
       ← Returns enrichment coverage stats for the tenant:
          total subscribers, enriched count, miss count,
          enrichment rate %, estimated monthly cost at current volume
       ← Auth: admin/owner only
```

---

## PART 8 — COST MANAGEMENT AND MONITORING

### 8.1 Enrichment Budget Controls

Every tenant has configurable enrichment budget limits stored in `tenant_scoring_config`:

```sql
ALTER TABLE tenant_scoring_config ADD COLUMN monthly_enrichment_budget integer DEFAULT 500;  
-- max enrichments per month. NULL = unlimited (enterprise only)

ALTER TABLE tenant_scoring_config ADD COLUMN enrichment_auto_trigger boolean DEFAULT true;
-- false = enrichment only runs when manually triggered by manager/admin
```

When `monthly_enrichment_budget` is set:
- `enrichment_jobs` table tracks total `pdl_credits_consumed` per tenant per month
- When 80% of budget is reached: email alert to tenant owner + Slack notification
- When 100% is reached: auto-enrichment is paused until next billing cycle. Manual enrichment still allowed.

### 8.2 Credit Cost Tracking

After every enrichment job completes, `credit_tracker.py` writes to `enrichment_jobs`:

```python
async def record_enrichment_job_completion(
    job_id: str,
    results: list[PDLPersonResult]
) -> None:
    """
    Records enrichment job completion including cost.
    PDL cost: $0.28 per HTTP 200. 404 = free.
    """
    pdl_charged = sum(1 for r in results if r.status == 200 and r.charged)
    estimated_cost = pdl_charged * 0.28  # update if PDL pricing changes
    
    await db.update("enrichment_jobs", job_id, {
        "status": "completed",
        "success_count": pdl_charged,
        "miss_count": sum(1 for r in results if r.status == 404),
        "pdl_credits_consumed": pdl_charged,
        "estimated_cost_usd": estimated_cost,
        "completed_at": "now()"
    })
```

---

## PART 9 — THE CLAY PARALLEL (Why This Architecture Mirrors Clay's Intelligence)

Clay does three things that make it powerful for sales and marketing: (1) it cleans and normalizes input data before spending money on enrichment, (2) it runs a waterfall through multiple providers to maximize hit rate, and (3) it takes the enriched data and triggers outbound actions (emails, CRM updates, LinkedIn sequences).

Lycert's enrichment architecture mirrors this exactly, but for a compliance and revenue recovery workflow:

| Clay (Sales/GTM) | Lycert (Compliance/Revenue Recovery) |
|---|---|
| Pre-enrichment: normalize company names, clean emails | Pre-enrichment: School Cleaner, Location Cleaner, domain classification |
| Waterfall: tries Provider A, then B, then C | Waterfall: PDL → Apollo → PDL Identify |
| Enrichment: full profile from best available source | Enrichment: PDL Person + Company Enrichment |
| Outbound action: send LinkedIn message, enroll in email sequence | Outbound action: queue graduation email, create compliance case, flag for sales team |
| Lead routing: route to SDR based on company size/ICP fit | Conversion routing: route to job-seeker offer vs team plan offer vs compliance notice |
| Score/qualify: ICP score, intent score | Score/qualify: Compliance tier, lifecycle stage, AEC Professional flag |

The difference: Clay helps sales find and reach new customers. Lycert helps compliance teams identify and convert existing customers who should be on a higher pricing tier. Same intelligence layer, entirely different business outcome.

---

## PART 10 — ENRICHMENT-RELATED MIGRATIONS TO RUN

These SQL migrations must be run in order, after the base schema migrations in LYCERT_ARCHITECTURE.md.

```
supabase/migrations/
├── 0016_pre_enrichment_columns.sql    ← Adds pre-enrichment columns to subscribers
├── 0017_enrichment_additions.sql      ← Adds pdl_likelihood, skills etc. to subscriber_enrichment
├── 0018_create_employer_enrichment.sql ← New subscriber_employer_enrichment table
├── 0019_create_enrichment_jobs.sql    ← Enrichment job tracking table
└── 0020_enrichment_budget_columns.sql ← Budget limit columns on tenant_scoring_config
```

---

## PART 11 — TESTING REQUIREMENTS

All enrichment code must have tests before merging to staging.

**Unit tests (no real API calls — use fixtures):**
- `test_field_mapper.py` — test every field mapping case including null/missing fields
- `test_education_end_date_extraction.py` — test year-only, year-month, missing, multiple entries
- `test_priority_queue.py` — test priority score calculation for each lifecycle stage
- `test_pre_enrichment.py` — test email domain classification for all domain_type values

**Integration tests (use PDL sandbox — free, no credits consumed):**
- PDL provides a Sandbox API that returns synthetic data without consuming credits
- Use `sandbox=true` parameter for all integration tests
- Test the full enrichment flow end-to-end against sandbox data
- Test fallback trigger (PDL miss → Apollo)
- Test low likelihood rejection (likelihood < 4 → treated as miss)

**Regression tests:**
- Run the CEDS sample_accounts.xlsx through the pre-enrichment pipeline
- Confirm that Location Cleaner produces identical country mapping to the old COUNTRY_ALIASES dict for all 30+ countries in the sample
- Confirm School Cleaner correctly normalizes all institutions in the sample that have correct names

---

*End of LYCERT_ENRICHMENT_ARCHITECTURE.md — Version 1.0*  
*Reference: https://docs.peopledatalabs.com/docs/person-enrichment-api*  
*Reference: https://docs.peopledatalabs.com/docs/bulk-enrichment-api*  
*Reference: https://docs.peopledatalabs.com/docs/supporting-endpoints*
