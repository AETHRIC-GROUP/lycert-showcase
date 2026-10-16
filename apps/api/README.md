# apps/api — reference implementation

A FastAPI service from the platform's first phase. **It is no longer a runtime dependency.** The TypeScript
engine in `apps/web` replaced it in June 2026, after the hosting platform proved unreliable for long
enrichment jobs. Two engines would drift, so the runtime was consolidated.

It is kept for one job: an **independent parity oracle**. The Python scoring engine and the TypeScript port
both have to reproduce the reference engine's output exactly on the same fixtures, which guards the port
against silent changes in scoring.

## Contents

```
main.py, start.py        FastAPI app + startup wrapper (Uvicorn)
middleware/              JWT auth middleware (Supabase-issued tokens)
routers/                 health, auth, subscribers, scores, cases, lifecycle, enrich
scoring/                 engine, field mapper, tier A/B/C signals
services/
  enrichment/            first waterfall: orchestrator, merge, pre-enrichment, priority queue,
                         credit tracking, provider clients
  audit.py, crypto.py, lifecycle.py, stripe_service.py
tests/                   pytest suite (230 tests), including the cross-engine regression
```

## Running

```bash
pip install -r requirements.txt
pytest                  # 230 tests
uvicorn main:app --reload
```

The regression test reads the synthetic fixtures in `docs/reference/`. It is skipped if they are missing.
