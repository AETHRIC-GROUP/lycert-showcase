"""Regression test — Lycert engine must produce identical scores to CEDS for all sample accounts.

Reference files (read-only, do not modify):
  docs/reference/sample_accounts.xlsx            — input data
  docs/reference/scored_sample_accounts_20260526.csv — expected output (reference date 2026-05-26)

Tolerance: total_score within ±1 (floating-point rounding), confidence_tier exact match.
"""
import pytest
import csv
from datetime import date
from pathlib import Path
from scoring.engine import score_row
from scoring.models import ScoringConfig, SubscriberRecord
from scoring.field_mapper import _parse_date, _extract_education_year

REF = date(2026, 5, 26)
CFG = ScoringConfig()

REFERENCE_DIR = Path(__file__).parents[4] / "docs" / "reference"
INPUT_FILE = REFERENCE_DIR / "sample_accounts.xlsx"
EXPECTED_FILE = REFERENCE_DIR / "scored_sample_accounts_20260526.csv"

PARTNER_FIELD_MAP = {
    "renewal_delta_days":       "Difference Before Last Renewal",
    "stated_graduation_date":   "Expected Graduation",
    "proof_submission_date":    "Proof Submission Date",
    "subscription_start_date":  "Subscription Start Date",
    "subscription_end_date":    "Subscription End Date",
    "email":                    "email",
    "account_name":             "Account Name",
    "institution_name":         "Institution Name",
    "institution_location":     "Institution Location",
    "account_country":          "Account Location",
    "li_current_employer_name": "LI Job Company Name",
    "li_job_end_date":          "LI Job End Date",
    "li_job_title":             "LI Title",
    "li_education_end_date":    "LI Education Date Range",
    "li_current_employer_domain": "Company Domain Name",
}


def _row_to_record(row: dict) -> SubscriberRecord:
    """Convert a raw design-partner CSV/Excel row to a SubscriberRecord."""
    def s(field: str) -> str:
        v = row.get(field, "")
        return "" if v is None or str(v).strip().lower() in ("nan", "none", "") else str(v).strip()

    def d(field: str):
        return _parse_date(row.get(field))

    def i(field: str):
        v = row.get(field, "")
        if v is None or str(v).strip().lower() in ("nan", "none", ""):
            return None
        try:
            return int(float(str(v)))
        except (ValueError, TypeError):
            return None

    def job_end(field: str):
        v = row.get(field, "")
        if v is None or str(v).strip().lower() in ("nan", "none", ""):
            return None
        return _parse_date(v)

    return SubscriberRecord(
        email=s("email"),
        account_name=s("Account Name"),
        institution_name=s("Institution Name"),
        institution_location=s("Institution Location"),
        account_country=s("Account Location"),
        stated_graduation_date=d("Expected Graduation"),
        renewal_delta_days=i("Difference Before Last Renewal"),
        proof_submission_date=d("Proof Submission Date"),
        subscription_start_date=d("Subscription Start Date"),
        subscription_end_date=d("Subscription End Date"),
        li_current_employer_name=s("LI Job Company Name"),
        li_job_end_date=job_end("LI Job End Date"),
        li_job_title=s("LI Title"),
        li_education_end_date=_extract_education_year(row.get("LI Education Date Range")),
        li_current_employer_domain=s("Company Domain Name"),
    )


@pytest.mark.skipif(
    not INPUT_FILE.exists() or not EXPECTED_FILE.exists(),
    reason="Reference files not found in docs/reference/",
)
def test_regression_scores_match_ceds():
    """Score all sample accounts and verify output matches scored_sample_accounts_20260526.csv."""
    import openpyxl
    wb = openpyxl.load_workbook(INPUT_FILE, read_only=True, data_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    headers = [str(h) if h else "" for h in rows[0]]
    input_rows = [dict(zip(headers, r)) for r in rows[1:]]

    with open(EXPECTED_FILE, encoding="utf-8-sig") as f:
        expected_rows = list(csv.DictReader(f))

    assert len(input_rows) == len(expected_rows), \
        f"Row count mismatch: input={len(input_rows)}, expected={len(expected_rows)}"

    mismatches = []
    for i, (raw, exp) in enumerate(zip(input_rows, expected_rows), start=1):
        record = _row_to_record(raw)
        result = score_row(record, CFG, REF)

        expected_score = int(float(exp.get("Total Score", "0") or 0))
        expected_tier = int(float(exp.get("Confidence Tier", "0") or 0))

        score_diff = abs(result.total_score - expected_score)
        tier_match = result.confidence_tier == expected_tier

        if score_diff > 1 or not tier_match:
            mismatches.append({
                "row": i,
                "email": raw.get("email", ""),
                "got_score": result.total_score,
                "exp_score": expected_score,
                "got_tier": result.confidence_tier,
                "exp_tier": expected_tier,
                "signals": result.signals_fired,
                "gaps": result.data_gaps,
            })

    if mismatches:
        detail = "\n".join(
            f"  Row {m['row']} ({m['email']}): score {m['got_score']} vs {m['exp_score']}, "
            f"tier {m['got_tier']} vs {m['exp_tier']} | signals={m['signals']} gaps={m['gaps']}"
            for m in mismatches[:20]
        )
        pytest.fail(
            f"{len(mismatches)} regression mismatches (showing first 20):\n{detail}"
        )
