# Scoring regression fixtures

Synthetic accounts used to prove that the Lycert scoring engines reproduce the original reference engine
(CEDS) exactly. CEDS was a single-file Python script written for the design partner. Its source is not
included in this public copy. These fixtures and the expected outputs it produced are what the regression
relies on.

| File | Role |
|---|---|
| `sample_accounts.xlsx` | Input: four synthetic subscriber accounts covering all three signal tiers, exculpatory signals and data gaps |
| `scored_sample_accounts_20260526.csv` / `.xlsx` | Expected output from the reference engine, reference date 2026-05-26 |

All names, emails and companies in these files are fictional.

**Where they are used**

- `apps/api/tests/scoring/test_regression.py` runs the Python engine against the files directly.
- `apps/web/lib/scoring/__fixtures__/ceds_regression.json` is generated from the same files by
  `scripts/build_scoring_regression_fixture.py`, with dates normalized to ISO strings so no spreadsheet-reader
  differences leak in. `apps/web/lib/scoring/regression.test.ts` runs the TypeScript engine against it.

Both tests require identical total scores and confidence tiers. Any change to scoring output fails them.
