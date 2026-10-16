# CLAUDE.md — Lycert Implementation Context
**Read this file at the start of every Claude Code session.**
**For product decisions, legal constraints, and full data model: see LYCERT_ARCHITECTURE.md**
**For current build status: see STATUS.md**
**For what to build next: see NEXT_STEPS.md**

---

## 🟢 CURRENT ROADMAP (2026-10-08): `LYCERT_BRIDGE_ARCHITECTURE.md` — READ THIS FIRST

**This is now the authoritative build sequence, superseding the phase roadmap below and the build-order
parts of the verification/document-review docs.** Lycert pivots from owning authoritative verification to
**orchestrating the client's existing CRM (HubSpot) + verification provider (SheerID)** — see the doc's
Part 0 for the one-paragraph version, Part 4 for exactly what to keep/build-on/improve/freeze/drop/defer,
and Part 12 for milestones M0–M5. **Go step by step through the milestones in order — do not start M2+
until the prior milestone's acceptance criteria pass and Joshua confirms.** `STATUS.md`/`NEXT_STEPS.md` are
kept in sync with the Bridge doc's milestone state; if they ever disagree, the Bridge doc wins and the
other two must be corrected to match it, not the other way round.

---

## MANDATORY: Migration Application Rule (Joshua's standing instruction, 2026-06-20)

**Claude Code applies database migrations to BOTH staging and prod itself — never tell Joshua to apply
a migration.** When a migration is created:
1. Apply it to staging (`<staging-project-ref>`) via Supabase MCP `apply_migration`.
2. Apply the same migration to prod (`<prod-project-ref>`) yourself — do not defer it or ask Joshua.
3. Record both in STATUS.md.

This overrides any older note that said "apply to prod when this merges to main." Migrations are
additive/safe to run ahead of the prod code deploy. (This does NOT authorize merging app code to
`main` / deploying features to production without Joshua's go-ahead — that rule still stands; only
migrations are auto-applied.)

---

## MANDATORY: Environment Variable Rule

**Before completing any build that adds or changes code referencing env vars:**
1. Open `STATUS.md` → "Environment Variables (Vercel)" table
2. Confirm every var referenced in the changed code already exists in the required Vercel environments
3. If a new var is needed: add it to STATUS.md table (with environment column status) AND tell Joshua exactly what to add in Vercel before pushing
4. NEVER assume a var is set in Vercel — always check the table

**When a var is added to Vercel:** update the STATUS.md table immediately with the correct environment checkmarks.

---

## MANDATORY: Staging Push Rule (UI changes)

**Any change that is expected to be reflected in the UI MUST be pushed to staging before reporting the work as done. No exceptions.**

1. Run `npm run build` in `apps/web` locally — the build must pass (Vercel runs strict type checking; a local pass prevents a broken staging deploy)
2. Commit on `develop`
3. Push: `git push origin develop && git push origin develop:staging`
4. Verify the Vercel deployment for the new commit reaches state **READY** (via Vercel MCP `list_deployments` / `get_deployment`) — a push alone is not enough; a failed build means the UI did not change
5. Only then tell Joshua the change is live on staging

Never describe UI work as complete while it exists only in the local working tree or only on `develop`.

---

## What Lycert Is (30-second version)

Lycert is a multi-tenant B2B SaaS platform that helps software companies recover revenue from EDU (education) license subscribers who have graduated and should be on commercial pricing. It does two things: (1) scores existing subscribers for potential license misuse, and (2) runs personalized conversion sequences on subscribers approaching graduation. Think "Checkr for software license compliance."

The scoring engine started as a local Python script (CEDS) built for the design partner. The Lycert platform is a universal, cloud-hosted, multi-tenant version of that engine — rebuilt from scratch with a proper data model, configurable per-client signals, and a full product around it.

---

## Repository Structure

```
lycert/
├── CLAUDE.md                    ← This file. Read first.
├── LYCERT_ARCHITECTURE.md       ← Full product spec. Authoritative.
├── STATUS.md                    ← Current build status. Updated after every session.
├── NEXT_STEPS.md                ← Exactly what to build next. Updated after every session.
├── DECISIONS.md                 ← Log of architecture decisions made during build.
│
├── apps/
│   ├── web/                     ← Next.js 14 frontend (App Router)
│   │   ├── app/                 ← App Router pages and layouts
│   │   ├── components/          ← Shared UI components
│   │   ├── lib/                 ← Utilities, Supabase client, type definitions
│   │   └── public/              ← Static assets
│   │
│   └── api/                     ← Python FastAPI backend
│       ├── main.py              ← FastAPI app entry point
│       ├── routers/             ← Route handlers (one file per domain)
│       ├── services/            ← Business logic (scoring, enrichment, email)
│       ├── models/              ← Pydantic models
│       ├── scoring/             ← Scoring engine (ported from CEDS)
│       └── tests/               ← Pytest tests
│
├── supabase/
│   ├── migrations/              ← SQL migration files (numbered, sequential)
│   ├── seed/                    ← Seed data for staging
│   └── functions/               ← Supabase Edge Functions (if needed)
│
├── docs/
│   └── reference/               ← CEDS original files (score_accounts.py, app.py)
│                                   Read-only reference. Do not modify.
│
└── .github/
    └── workflows/               ← CI/CD pipelines
```

---

## Branch and Environment Rules

**This is non-negotiable. Read carefully.**

| Branch | Environment | Who can push | Auto-deploys to |
|---|---|---|---|
| `develop` | local dev only | Claude Code freely | nothing |
| `staging` | staging infra | Claude Code (default push target) | Vercel staging, Railway staging |
| `main` | production | Joshua only (or Claude Code when Joshua explicitly says "push to production") | Vercel production, Railway production |

**Claude Code's default behaviour:**
- Work on `develop` branch
- When a feature is complete and tested: push to `staging` branch
- Never push to `main` without Joshua explicitly saying "deploy to production" or "merge to main"
- Always run tests before any push to staging

**PR process:**
- `staging` → `main` requires Joshua's manual review and merge
- Every merge to `main` must have a corresponding STATUS.md update confirming what shipped

---

## Staging vs Production — Infrastructure Separation

Every piece of infrastructure has a staging and production version. They are completely separate. No data ever flows between them.

| Infrastructure | Staging | Production |
|---|---|---|
| Supabase | Project: `lycert-staging` (EU Frankfurt) | Project: `lycert-prod` (EU Frankfurt) |
| Vercel | Preview deployments from `staging` branch | Production deployment from `main` branch |
| Railway | `lycert-api-staging` service | `lycert-api-production` service |
| Upstash Redis | Staging database | Production database |
| Resend | Staging API key (emails to sandbox only) | Production API key |
| Stripe | Test mode keys | Live mode keys |
| WorkOS | Staging environment | Production environment |
| Environment files | `.env.staging` | `.env.production` |

**Environment variable naming convention:**
- All env vars are prefixed: `LYCERT_`
- Environment-specific vars: `LYCERT_SUPABASE_URL_STAGING` vs `LYCERT_SUPABASE_URL_PROD`
- Never hardcode any URL, key, or secret. Always use env vars.
- `.env.staging` and `.env.production` are never committed. `.env.example` is committed and kept current.

---

## The Original Scoring Engine (CEDS) — Reference Only

The original tool is at `docs/reference/score_accounts.py`. Do NOT modify it. It is the reference implementation. The Lycert scoring engine must produce identical results for identical inputs.

**Key things to understand about the CEDS engine before porting it:**

**Signal architecture:** 11 signals across 3 tiers. Each signal function `score_XX(row)` returns `(int, str, str)` — points, signal_key, description. This pattern must be preserved in the Lycert engine.

**Post-processing rules (applied after all signals run):**
1. A2 cap: if A1 fired at `A1_renewed_365d_after_grad` or `A1_renewed_180d_after_grad`, cap any A2 signal to max 5 pts
2. AEC Professional Confirmed: boolean, True only when C1_currently_employed AND LI Title contains AEC keyword

**Data gaps:** missing data is NEVER penalised. It scores 0 and is recorded in data_gaps. This is a legal requirement, not just a product decision.

**Determinism:** same inputs on same date = same outputs. The engine uses a reference date, not `datetime.now()` at call time. This is critical for audit trail integrity.

**The Lycert version differs from CEDS in these ways:**
- Signal weights are read from `tenant_scoring_config` table, not hardcoded constants
- The `vertical_tag` field on each signal allows non-AEC verticals to define their own keyword sets
- Input fields are mapped through a normalization layer (different companies use different column names)
- Output is written to `subscriber_scores` table, not an Excel file
- The engine is exposed as a FastAPI endpoint, not a CLI script

---

## Universal Field Mapping — How Different Companies' Data Gets Normalized

This is one of the most important architectural decisions in Lycert. The design partner calls their field "Difference Before Last Renewal." Another company might call it "days_since_graduation_at_renewal" or not have it at all.

**The normalization layer:**

Every tenant has a field mapping configuration (stored in `tenant_field_mappings` table, defined in LYCERT_ARCHITECTURE.md). It maps the client's column names to Lycert's canonical field names:

```
Canonical field name         ← Client's actual column name
─────────────────────────────────────────────────────────
renewal_delta_days           ← "Difference Before Last Renewal" (the design partner)
                             ← "days_to_renewal_from_grad" (other client)
                             ← CALCULATED if not present (see below)

stated_graduation_date       ← "Expected Graduation" (the design partner)
                             ← "graduation_date" (other client)
                             ← "grad_date" (other client)

email                        ← "email" (universal)
subscriber_name              ← "Contact Name" (the design-partner Salesforce)
                             ← "name" (generic)
...
```

**Calculated fields:** If a client doesn't have `renewal_delta_days` but has `last_renewal_date` and `stated_graduation_date`, Lycert calculates it: `renewal_delta_days = (last_renewal_date - stated_graduation_date).days`. The calculation is documented and logged so it is auditable.

**Missing fields:** If a canonical field has no mapping and cannot be calculated, the corresponding signals score 0 and the field is recorded in `data_gaps`. Never fail on missing data.

---

## Scoring Engine — Universal vs Vertical-Specific Signals

The 11 CEDS signals generalize across all software companies. Some signals are universal, some are vertical-specific.

**Universal signals (work for all companies, all plan types):**
- A1: Renewal after stated qualification end date (graduation = EDU; nonprofit status expiry = nonprofit; funding round date = startup)
- A2: Qualification end date already past
- A3: Proof submitted before subscription started
- A4: Subscription duration exceeds expected program length
- B1: Email domain classification
- B2: Institution/organization name quality
- B3: Country mismatch
- C1: Currently employed (LinkedIn)
- C2: Job title keywords (configurable per vertical)
- C3: Education/affiliation end year (LinkedIn)
- C4: Employer domain classification

**Vertical-specific signal configurations (stored in `tenant_scoring_config`):**
- `vertical_tag`: 'aec' / 'design' / 'gaming' / 'devtools' / 'generic'
- `professional_keyword_set`: the C2 strong/weak keywords, configurable per vertical
- `organization_type_label`: "institution" (EDU) / "nonprofit" (nonprofit) / "employer" (startup)
- `qualification_label`: "graduation date" / "nonprofit status expiry" / "funding date"

When Claude Code ports signals, every keyword list must be a configurable constant loaded from `tenant_scoring_config`, not hardcoded. The CEDS constants (STRONG_PROFESSIONAL_KEYWORDS, AEC_PROFESSIONAL_KEYWORDS etc.) become the default values for the 'aec' vertical.

---

## Testing Architecture

Tests are set up from Phase 1. No feature ships to staging without passing tests.

**Testing stack:**
- **Unit tests:** Pytest (Python/FastAPI), **Vitest (TypeScript/Next.js)** — Vitest is the TS test
  runner as of 2026-06-13 (engine consolidation; faster + better TS ergonomics). The earlier "Jest"
  reference predates this decision.
- **Integration tests:** Pytest with test Supabase client (pointing at staging DB)
- **E2E tests:** Playwright — added in Phase 2 when the UI is substantive
- **CI:** GitHub Actions runs all tests on every push to `staging` branch

**Test file locations:**
- `apps/api/tests/` — all Python tests
- `apps/web/` — TypeScript Vitest tests (co-located `*.test.ts` or `apps/web/__tests__/`)
- `e2e/` — all Playwright tests (root level)

**Mandatory test coverage for the scoring engine:**
Every signal function must have:
1. A test for each sub-rule (every `if` branch)
2. A test for the data_gap case (missing input)
3. A test for exculpatory behaviour where applicable
4. An integration test for `score_row()` producing correct output for a known input

The CEDS `sample_accounts.xlsx` and `scored_sample_accounts_20260526.csv` in `docs/reference/` are the canonical regression test fixtures. The Lycert scoring engine must produce identical scores for the sample accounts (after field mapping). This is a regression test that runs on every CI build.

**Playwright E2E test structure (Phase 2 onward):**
```
e2e/
├── fixtures/           ← Test tenant setup, synthetic subscriber data
├── auth/               ← Login, SSO, role enforcement tests
├── subscribers/        ← Import, scoring, detail view tests
├── cases/              ← Case management workflow tests
├── email/              ← Email queue, sandbox, approval tests
└── settings/           ← Integration, billing, config tests
```

---

## Code Conventions

**Python (FastAPI):**
- Python 3.11+
- Type hints on all function signatures
- Pydantic v2 for all request/response models
- Signal functions always return `tuple[int, str, str]` — (points, signal_key, description)
- No business logic in route handlers — all logic in `services/`
- Every service function that writes to the database also writes an audit_log entry
- Never catch bare `Exception` without logging the full traceback

**TypeScript (Next.js):**
- TypeScript strict mode
- No `any` types
- Supabase generated types used throughout (run `supabase gen types` after schema changes)
- Server Components by default, Client Components only when interactivity requires it
- All forms: react-hook-form + zod validation

**Database (Supabase / PostgreSQL):**
- Every table has RLS enabled from creation — no exceptions
- Every migration is numbered sequentially: `0001_create_tenants.sql`, `0002_create_tenant_users.sql`
- Migrations are never edited after they run on staging. New changes = new migration file.
- Foreign keys always explicit with ON DELETE behaviour specified
- Timestamps: always `timestamptz`, never `timestamp`
- Boolean columns: never nullable — always have a default

**General:**
- No secrets in code, ever
- No `console.log` in production code — use structured logging
- All API endpoints have explicit auth checks — never rely on "this endpoint isn't linked anywhere"
- Every database write is wrapped in a try/catch with appropriate error handling

---

## How to Handle Uncertainty

When you (Claude Code) are uncertain about a product decision, architectural choice, or scope:

1. **Check LYCERT_ARCHITECTURE.md first.** It is the authoritative answer.
2. **Check DECISIONS.md.** A previous decision may have covered it.
3. **If still uncertain: stop and ask Joshua.** Do not guess on:
   - Anything touching legal/GDPR constraints
   - Database schema changes
   - Anything that would change the scoring engine's output
   - Security-related decisions
   - Whether a feature is in scope for the current phase

4. **Never build a feature not in the current phase's scope** even if it seems like a natural next step. Update NEXT_STEPS.md and ask Joshua first.

---

## Session Start Protocol

At the start of every Claude Code session:
1. Read `STATUS.md` — understand where we are
2. Read `NEXT_STEPS.md` — understand exactly what to build
3. Check the current git branch — should be `develop`
4. Run existing tests to confirm the baseline is green before adding new code

## Session End Protocol

At the end of every Claude Code session:
1. Run all tests — fix any failures before ending
2. Update `STATUS.md` with what was completed
3. Update `NEXT_STEPS.md` with what comes next (specific, not vague)
4. Commit with a descriptive message: `feat(scoring): port A1-A4 signals with unit tests`
5. If the feature is complete and tested: push to `staging`
6. Never leave the codebase in a broken state between sessions

---

## Context Management — When to Clear Context

Context in Claude Code sessions is expensive. Some context is permanent (this file, LYCERT_ARCHITECTURE.md), some is phase-specific.

**Permanent context (always in scope):**
- CLAUDE.md (this file)
- STATUS.md
- NEXT_STEPS.md

**Phase-specific context (load only when needed):**
- LYCERT_ARCHITECTURE.md Phase 1 section: load during Phase 1 build
- LYCERT_ARCHITECTURE.md Phase 2 section: load during Phase 2 build (Phase 1 section can be dropped from active context once Phase 1 is confirmed complete by Joshua)
- Individual signal implementation: load only when working on the scoring engine
- Email system: load only when working on email features

**Context clearing signal:**
When Joshua says "Phase 1 is confirmed done, move to Phase 2", that is the signal to:
1. Archive Phase 1 implementation notes from NEXT_STEPS.md into a `PHASE_1_COMPLETE.md` file
2. Start NEXT_STEPS.md fresh with Phase 2 tasks
3. In future sessions, only load Phase 2 sections of LYCERT_ARCHITECTURE.md
4. The CEDS reference files can be dropped from active context once the scoring engine port is regression-tested and passing
