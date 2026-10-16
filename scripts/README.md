# scripts

One-off and benchmarking tools. None of them are part of the running application.

| Script | Purpose |
|---|---|
| `build_scoring_regression_fixture.py` | Builds the TypeScript regression fixture from the reference spreadsheets, normalizing dates to ISO strings |
| `select_ground_truth.py` | Selects a diverse benchmark sample (by email type, country, institution) from a ground-truth file with known correct answers |
| `benchmark_providers.py`, `benchmark_capture.py` | Python enrichment-provider benchmark and raw-response capture |
| `fullenrich_live_test.py` | Live end-to-end check of the asynchronous FullEnrich flow |

TypeScript benchmark runners for the current engine are in `apps/web/scripts/`.

**Data handling.** Benchmarks run against real subscriber records with known answers, so their inputs and
captured responses contain personal data. Those files are git-ignored and are deleted after the aggregate
results are extracted. Only aggregate results are kept.
