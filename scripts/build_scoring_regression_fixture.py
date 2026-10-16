#!/usr/bin/env python3
"""Build the CEDS scoring regression fixture for the TypeScript engine.

Reads the two reference files (the same ones the Python regression uses) and emits a single
committed JSON fixture the Vitest regression consumes. This isolates the parity gate to the
scoring LOGIC by feeding the TS field-mapper + engine exactly the same raw design-partner inputs the
Python engine sees — with date cells normalised to ISO strings so there is no xlsx-reader drift
between openpyxl (Python) and SheetJS (JS).

Output: apps/web/lib/scoring/__fixtures__/ceds_regression.json
  [{ "input": { "<partner column name>": <value> , ... }, "expected": { "total_score": N, "confidence_tier": T } }, ...]

Reference date for the expected scores: 2026-05-26 (encoded in the expected CSV filename).
Run: python scripts/build_scoring_regression_fixture.py
"""
import csv
import json
from datetime import date, datetime
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
REF = REPO / "docs" / "reference"
INPUT_XLSX = REF / "sample_accounts.xlsx"
EXPECTED_CSV = REF / "scored_sample_accounts_20260526.csv"
OUT = REPO / "apps" / "web" / "lib" / "scoring" / "__fixtures__" / "ceds_regression.json"

# Columns the scoring field-mapper reads (the design-partner names). Kept verbatim so the TS port maps them.
INPUT_COLUMNS = [
    "email", "Account Name", "Institution Name", "Institution Location", "Account Location",
    "Expected Graduation", "Difference Before Last Renewal", "Proof Submission Date",
    "Subscription Start Date", "Subscription End Date",
    "LI Job Company Name", "LI Job End Date", "LI Title", "LI Education Date Range",
    "Company Domain Name",
]


def _cell(value):
    """Normalise an openpyxl cell: dates → ISO string, None → '', numbers kept, else str."""
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, (int, float)):
        return value
    s = str(value).strip()
    return "" if s.lower() in ("nan", "nat", "none") else s


def main() -> int:
    import openpyxl
    wb = openpyxl.load_workbook(INPUT_XLSX, read_only=True, data_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    headers = [str(h) if h else "" for h in rows[0]]
    input_rows = [dict(zip(headers, r)) for r in rows[1:]]

    with open(EXPECTED_CSV, encoding="utf-8-sig") as f:
        expected_rows = list(csv.DictReader(f))

    assert len(input_rows) == len(expected_rows), \
        f"row count mismatch input={len(input_rows)} expected={len(expected_rows)}"

    fixture = []
    for raw, exp in zip(input_rows, expected_rows):
        fixture.append({
            "input": {col: _cell(raw.get(col)) for col in INPUT_COLUMNS},
            "expected": {
                "total_score": int(float(exp.get("Total Score", "0") or 0)),
                "confidence_tier": int(float(exp.get("Confidence Tier", "0") or 0)),
            },
        })

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(fixture, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {len(fixture)} rows to {OUT.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
