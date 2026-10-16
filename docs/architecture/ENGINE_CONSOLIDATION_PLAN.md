# ENGINE_CONSOLIDATION_PLAN.md
**Date:** 2026-06-13
**Status:** REV 2 — plan approved 2026-06-13 with the mandatory job-execution section now added
(below). Awaiting Joshua's approval of THIS queue-architecture revision before any porting begins.
**Decision:** Consolidate on the **TypeScript engine (Supabase + Vercel)**. Retire Railway/Python
as a runtime dependency. See DECISIONS.md 2026-06-13 (engine consolidation).

> Scope of this document: inventory only. No porting code has been written. Porting begins only
> after Joshua approves this plan. Migrations 0024–0029 are held until approval so schema + runtime
> ship together.

---

## 0. Why this is needed (the problem in one paragraph)

The V2 waterfall was built faithfully in the **Python** backend (`apps/api/`), but the **live**
product runs the **TypeScript** engine on Vercel and Railway is down (502). So the V2 cascade does
not execute when a user clicks Enrich. Worse, the TS scoring is a display-only approximation and
**nothing in TS persists `subscriber_scores`** — authoritative scoring depends on the dead Python
runtime. We are unifying on one engine (TS) to end the drift and the dead-code situation.

---

## (a) Python engine inventory — what exists today (the source we port FROM)

| # | Module | Logic | Persists to |
|---|---|---|---|
| P1 | `apps/api/scoring/` (`engine.py`, `signals/`, `field_mapper.py`, `models.py`) | **Authoritative CEDS scoring engine.** 11 signals (A1–A4, B1–B3, C1–C4), weights from `tenant_scoring_config`, vertical keyword sets, field normalization layer. Post-processing: **A2 cap** (≤5 pts when A1 fired at 365d/180d), **aec_professional_confirmed** boolean. **Determinism via a reference date** (not `now()`). Data gaps never penalised. | `subscriber_scores` |
| P2 | `services/enrichment/pre_enrichment.py` | School Cleaner + Location Cleaner (×2) + email domain classification + `compute_enrichment_priority`; upserts `institutions`, loads `trust_tier`. | `subscribers.*`, `institutions` |
| P3 | `services/enrichment/orchestrator.py` | **V2 registry-driven cascade**: Stage 0 gate, `load_cascade` (registry + tenant override), row-wise sync cascade with stop-on-COMPLETE, async handoff at priority ≥ 40. | `subscriber_enrichment` |
| P4 | `services/enrichment/providers/` | ZeroBounce, Hunter, ReverseContact (15 rps), Datagma, PDL (adapter), Apollo (disabled), FullEnrich (async). `base.py` `classify_completeness` (Part 2.3). | — |
| P5 | `services/enrichment/merge.py` | **Part 5 merge rules**: first-wins, PDL education override, same-employer date completion, different-employer block replacement, wrong-person guard, provenance. | — |
| P6 | `services/enrichment/async_webhook.py` + route | FullEnrich webhook: HMAC-SHA1 signature verify, idempotent dedupe, 24h stale-pending cleanup. | `subscriber_enrichment`, `audit_logs` |
| P7 | `services/enrichment/company_enrichment.py` | PDL-gated (likelihood ≥ 6) employer enrichment. | `subscriber_employer_enrichment` |
| P8 | `services/enrichment/credit_tracker.py` | `enrichment_jobs` lifecycle, `per_provider_stats`, budget enforcement across providers. | `enrichment_jobs` |
| P9 | `services/enrichment/field_mapper.py` | Per-provider → canonical field mappers + `_map_linkedin_style_profile` + GDPR `strip_to_canonical`. | — |

**Test oracle:** `apps/api/tests/` — 230 passing tests, incl. the CEDS regression
(`test_regression.py`) comparing against `docs/reference/scored_sample_accounts_20260526.csv`
at **reference date 2026-05-26**, exact row match. This stays as the reference oracle we port against.

---

## (b) TypeScript engine inventory — what exists today (where we port TO)

| Module | What it does today | Coverage |
|---|---|---|
| `lib/enrichment/engine.ts` (447 lines) | Enrichment waterfall **PDL bulk → Apollo (fallback + gap-fill)** only. Writes `subscriber_enrichment`. Runs on Vercel. | Covers **2 of 7** providers; no Stage 0, no registry cascade, no Part 5 merge, no async, no provenance/completeness. |
| `lib/utils/signals.ts` (425 lines) | **Display-only** signal estimate. Header: *"display-only estimates — the authoritative score is from the Python engine."* Hardcoded AEC keywords; **no** `tenant_scoring_config`, **no** A2 cap, **no** aec_professional_confirmed, uses `new Date()` (not deterministic). | **Not CEDS-parity. Does NOT persist `subscriber_scores`.** |
| `app/api/pre-enrich/batch/route.ts` | Email domain classification + `enrichment_priority`. | **PDL School/Location cleaner explicitly skipped** (line 128: "runs on Railway when available"). No `institutions` upsert, no trust_tier, no `*_country_normalized`. |
| `app/api/enrich/batch`, `enrich/subscriber/[id]` | Trigger routes for the TS enrichment engine. | PDL+Apollo only. No `enrichment_jobs`/budget tracking. |
| `app/api/enrichment/providers`, `waterfall` (built this session) | Settings UI data + tenant_waterfall_config writes. | Ready; reads registry tables (need migrations applied). |
| `lib/utils/lifecycle.ts`, `app/api/lifecycle/run` | Lifecycle stage engine. | Complete, already TS-native. |

---

## (c) The gap — what must be ported (prioritised)

### 🔴 PRIORITY 1 — Scoring engine parity (the parity question, answered)
**The TS scoring engine does NOT currently match the Python/CEDS output.** `signals.ts` is an
approximation and nothing persists `subscriber_scores`. This is the top gap.
- Port `apps/api/scoring/` to TS: all 11 signals, `tenant_scoring_config`-driven weights + vertical
  keyword sets, the field normalization layer, **A2 cap**, **aec_professional_confirmed**, and
  **reference-date determinism** (accept a reference date param; never `new Date()` for scoring).
- **Persist** to `subscriber_scores` (currently never written in TS).
- **Acceptance gate:** a TS regression test runs the same `docs/reference/sample_accounts.xlsx`
  through the TS engine at reference date **2026-05-26** and matches
  `scored_sample_accounts_20260526.csv` row-for-row — the identical bar the Python test enforces.
  Until that passes, scoring consolidation is not done.
- `signals.ts` is then either deleted or reduced to a thin display wrapper over the real engine.

### 🔴 PRIORITY 2 — V2 enrichment cascade
Replace the PDL+Apollo `engine.ts` with the full registry-driven cascade:
- Providers P4 (ZeroBounce/Hunter/ReverseContact/Datagma/FullEnrich; PDL/Apollo retained), Stage 0
  gate with 180-day cache, `load_cascade` (registry + `tenant_waterfall_config`), stop-on-COMPLETE,
  async handoff at priority ≥ 40.
- Part 5 merge engine (P5) and `classify_completeness` (Part 2.3).
- Provenance / completeness / providers_attempted columns.

### 🔴 PRIORITY 3 — FullEnrich async webhook
Port P6 to a Next route: HMAC-SHA1 verify (configurable header), idempotent dedupe on
(enrichment_id, subscriber_id), background processing, 200-fast, + a Vercel-cron 24h cleanup.

### 🟠 PRIORITY 4 — Pre-enrichment completion
Port the skipped pieces of P2 into TS: PDL School Cleaner, Location Cleaner (×2), `institutions`
upsert + trust_tier load. (Email classification + priority already in TS.)
- **B3 wiring (done in scoring 2026-06-14, needs the data fed):** B3 now prefers
  `institution_country_normalized` / `account_country_normalized` (Location-Cleaner output), with
  raw+alias fallback. When the V2 cascade / scoring path builds a `SubscriberRecord` from a
  `subscribers` row, it MUST populate those two fields from the row so the normalized path actually
  fires (otherwise B3 silently uses the fallback). Pre-enrichment is what writes those columns, so
  this priority closes the loop.

### 🟠 PRIORITY 5 — Credit/job tracking + budget
Port P8: `enrichment_jobs` lifecycle, `per_provider_stats`, budget metering across providers
(`get_monthly_usage` via `success_count`). The Settings UI already reads `per_provider_stats`.

### 🟡 PRIORITY 6 — Company-enrichment trigger
Port P7 (PDL-gated, likelihood ≥ 6) → `subscriber_employer_enrichment`. (Note the activation-rate
caveat already in DECISIONS.md: PDL at position 4 means fewer triggers.)

### 🟡 PRIORITY 7 — Scheduling glue
Vercel cron for the async timeout sweep; scoring auto-trigger after enrichment (currently the
Python orchestrator queues scoring via audit event — in TS this becomes a direct scoring call).

---

## Job execution architecture (MANDATORY — Supabase Queues; approved 2026-06-13)

**Hard rule:** no batch enrichment or scoring job ever runs inside a Vercel request handler. Long,
rate-limited, stateful jobs run on a durable queue with job state persisted in Postgres. This is the
failure mode that actually killed Railway (stateful long jobs on an unsuitable host); a Vercel
function hits the identical wall at 100k subscribers (function timeout) — and would pass every
20-row test while dying in production.

**Runtime:** Supabase Queues (**pgmq**) + **pg_cron** (scheduler) + **pg_net** (async HTTP) +
**Edge Functions** (workers) — Supabase's own canonical async pattern. No new vendor.

**pgmq primitives (verified against Supabase docs, 2026-06-13):**
- `pgmq.send(queue_name, msg jsonb)` — enqueue a work item.
- `pgmq.read(queue_name, vt, qty)` — pull ≤`qty` messages, each hidden for `vt` seconds (visibility
  timeout). Returns `msg_id`, `read_ct` (delivery count), `enqueued_at`, `vt`, `message`.
- `pgmq.archive(queue_name, msg_id)` / `pgmq.delete(queue_name, msg_id)` — on success.
- **Retry = visibility timeout:** if a worker errors/dies, the message reappears after `vt` and is
  re-read; `read_ct` gives max-attempts → past a threshold, move to a dead-letter queue.
- We do **not** use `pgmq.pop` (read+delete = at-most-once; unsafe when processing can fail).

**Topology:**
1. **Trigger routes do not process — they enqueue.** `/api/enrich/batch`, `/api/enrich/subscriber/[id]`,
   `/api/score`, CSV import, and the backfill each `pgmq.send` work items + create an `enrichment_jobs`
   row (status `queued`) and return immediately. The Vercel handler does ≈no work.
2. **`pg_cron`** runs a small SQL dispatcher every N seconds that `pgmq.read`s a bounded batch and
   uses **`pg_net`** to invoke the worker **Edge Function** (async, fire-and-forget).
3. **Worker Edge Function** processes its chunk under per-provider rate limits, writes results +
   progress to Postgres, then `archive`s completed messages. Failed/unfinished messages reappear via
   `vt` and are retried.
4. **Job state lives in `enrichment_jobs`** (already built — `per_provider_stats`, counts, status).
   The queue carries work items; Postgres carries truth.

**Queues — separate by design (confirmed intentional):**
- `enrichment_jobs_q` — one message per subscriber (or small chunk) → runs the V2 cascade.
  Rate-limited, slow (external provider latency).
- `scoring_q` — enqueued **after** enrichment writes `subscriber_enrichment` (Q2 durability rule);
  the scoring worker scores → writes `subscriber_scores`. Fast, no external dependency.
- **Two physically separate queues with independent cron schedules and chunk sizes**, so a backlog
  of slow enrichment work can never starve fast scoring. (Not one shared queue.)
- `enrichment_dlq` / `scoring_dlq` — dead letters past the `read_ct` threshold.

**Chunk size — the one number that silently breaks this at scale:**
- Each worker invocation must finish **comfortably within the Edge Function execution timeout
  (~150s on the relevant tier)**, including the latency of the **slowest provider in the chunk**.
  A chunk too large times out mid-processing — recoverable (the message reappears via `vt`) but
  wasteful and can thrash.
- Calculation (conservative, enrichment queue): budget ≈ 120s usable (leave ~30s headroom under
  150s). Worst-case per-subscriber latency through the sync cascade ≈ sum of slowest provider calls
  ≈ ~6–8s (ReverseContact + Datagma + PDL, each a few seconds). ⇒ `ENRICHMENT_CHUNK_SIZE ≈ 120 / 8 ≈
  15 subscribers/invocation` as the starting value. ReverseContact's 15 rps cap is satisfied by the
  in-worker token bucket regardless. The scoring queue has no external calls, so
  `SCORING_CHUNK_SIZE` can be far larger (e.g. 200) and is timeout-bound only by CPU.
- **Both are named, easily-tunable constants** (e.g. `ENRICHMENT_CHUNK_SIZE`, `SCORING_CHUNK_SIZE` in
  one config module) — never magic numbers in the worker body. **These are the first thing we watch
  during the backfill load test** and tune from observed p95 invocation time.

**Dead-letter handling must be observable — never silent:**
- When a message exceeds the `read_ct` threshold and is moved to `*_dlq`, the worker also writes a
  visible record: the subscriber's `enrichment_jobs` row (or a per-subscriber failure row) is marked
  `status='failed'` with a `error_message`/reason, and a **dead-letter count is surfaced in the
  dashboard** (enrichment coverage / Settings). Rationale: a subscriber whose message silently died
  would have no data forever and only surface when a client asks "why does this person have nothing?"
  — we build that visibility in from the start, not after the first incident.

**Multi-step retry without a step-function engine (why pgmq suffices):**
- The per-subscriber waterfall is multi-provider, so a retry re-runs the cascade. The worker is
  therefore **idempotent + checkpointed**: it reads `subscriber_enrichment.providers_attempted` and
  **skips providers already attempted** for that subscriber, so a retry never re-charges a provider.
  ZeroBounce is cached 180d; the async FullEnrich step is tracked by `pending_async_provider`.
- The async FullEnrich step never blocks a worker: submit → mark pending → archive the message; the
  existing webhook + 24h cleanup complete it out-of-band.
- **Fallback policy (your condition):** if during porting a concrete multi-step retry requirement
  emerges that pgmq + checkpointing genuinely cannot express (e.g. cross-message saga ordering), I
  STOP and flag you with the specific reason **before** adopting Inngest or Trigger.dev. No vendor is
  added silently.

**New schema (a future migration, NOT applied until porting):** enable `pgmq` + `pg_cron` + `pg_net`;
create the queues + dead-letter queues; add any job↔message linkage columns. Drafted at port time and
applied with the other runtime changes.

---

## Test strategy

- **Test runner: Vitest** (Q1 decided). The CEDS regression is ported **first, as a red test**,
  before the engine it tests — so we build `lib/scoring/` against a failing test that goes green.
- Mirror the Python unit suite in TS as each piece ports: per-provider mappers, merge rules, cascade
  stop/continue, Stage 0 gating, async threshold, webhook signature/idempotency/cleanup, load_cascade.
- **The Python suite stays green throughout** as the reference oracle; it is not deleted until the TS
  engine passes the equivalent tests (esp. the CEDS regression) and the three teardown conditions
  below are met.

---

## What gets marked superseded (not deleted)

`apps/api/` enrichment + scoring is the **reference implementation we port from**. SUPERSEDED/REFERENCE
banners are on `orchestrator.py` + `scoring/engine.py` with a DECISIONS.md note. Kept in the repo,
kept green, removed only after the teardown conditions below.

---

## Resolved decisions (Joshua, 2026-06-13)

1. **Test runner: Vitest** (faster, better TS ergonomics). CLAUDE.md updated to name Vitest as the TS
   test runner. Port the CEDS regression first (red → green).
2. **Scoring engine: `lib/scoring/`**, triggered three ways — (a) after an enrichment job completes
   for a subscriber, (b) after CSV import (billing-signal-only pre-scoring), (c) explicit `/api/score`
   for manual re-scoring. The scoring run itself is a **queued job** (`scoring_q`), never inline:
   enrichment writes `subscriber_enrichment` → enqueues a scoring message → scoring worker picks it up.
3. **Backfill: yes, queued, only after parity is proven.** Once the TS engine passes the CEDS
   regression row-for-row, run a one-off backfill that re-scores all existing subscribers through the
   real engine (their current `subscriber_scores` are absent or from the display-only approximation
   and can't be trusted). Runs through the same queue — also a real-world load test of the queue
   before clients hit it. Logged in DECISIONS.md.
4. **Railway: leave dormant, do not tear down yet.** Keep the Python services dormant (not serving)
   and the Python suite green as the reference oracle until **all three** hold: (i) TS engine passes
   the CEDS regression, (ii) the backfill has run successfully, (iii) we've watched one real
   enrichment batch run on the queue in staging without failure. Only then retire Railway + remove
   `NEXT_PUBLIC_LYCERT_API_URL`. Python code stays in-repo as reference.

---

## Rollout (revised, approved 2026-06-13)

1. Write the queue/job-execution section into the plan → **Joshua approves** *(this revision)*.
2. Port the CEDS regression test to Vitest (red).
3. Port `lib/scoring/` until the regression goes green row-for-row at reference date **2026-05-26**.
4. Port pre-enrichment completion (School Cleaner, Location Cleaner, `institutions` upsert).
5. Port the V2 cascade + merge engine, **running on the queue**.
6. Port the FullEnrich webhook + idempotency + cleanup cron.
7. Port credit/job tracking, company enrichment, scheduling glue.
8. **Joshua** applies migrations 0024–0029 + adds provider keys + verifies FullEnrich signature.
9. Run the backfill on the queue (load test).
10. Benchmark providers against the design-partner sample.
11. Staging → review → main → retire Railway (after the three teardown conditions).

> Porting (step 2+) does not begin until Joshua approves this queue-architecture revision.
