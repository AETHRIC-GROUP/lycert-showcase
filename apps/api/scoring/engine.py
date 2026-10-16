# ┌─────────────────────────────────────────────────────────────────────────────┐
# │ SUPERSEDED / REFERENCE IMPLEMENTATION (2026-06-13)                            │
# │ Canonical scoring is moving to the TypeScript engine (Supabase + Vercel).     │
# │ This module + its CEDS regression test are the REFERENCE ORACLE the TS port   │
# │ must match (sample_accounts.xlsx vs scored_sample_accounts_20260526.csv, ref  │
# │ date 2026-05-26). Kept green; removed only after the TS engine passes the same │
# │ regression. See ENGINE_CONSOLIDATION_PLAN.md and DECISIONS.md 2026-06-13.      │
# └─────────────────────────────────────────────────────────────────────────────┘
"""Lycert scoring engine — deterministic port of the CEDS model.

Differences from CEDS (score_accounts.py):
- Signal weights loaded from ScoringConfig (not hardcoded constants)
- Input is SubscriberRecord Pydantic model (not pandas Series)
- Output is ScoreResult Pydantic model (not Excel/dict)
- Reference date is a parameter (not date.today()) — ensures determinism
- No Excel writing; results go to subscriber_scores table
"""
from __future__ import annotations
from datetime import date
from scoring.models import ScoringConfig, SubscriberRecord, ScoreResult
from scoring.signals.tier_a import score_a1, score_a2, score_a3, score_a4
from scoring.signals.tier_b import score_b1, score_b2, score_b3
from scoring.signals.tier_c import score_c1, score_c2, score_c3, score_c4

SCORING_VERSION = "1.0.0"

# Tier map: (min_score, max_score, tier_num, label, action)
_TIER_MAP = [
    (65, 100, 1, "Near-Certain Violation",    "Contact Now"),
    (40,  64, 2, "High Confidence Violation", "Second Wave"),
    (20,  39, 3, "Watch List",                "Monitor at Renewal"),
    (0,   19, 0, "Likely Clean",              "No Action"),
]

_A1_STRONG_KEYS = {"A1_renewed_365d_after_grad", "A1_renewed_180d_after_grad"}


def score_row(
    record: SubscriberRecord,
    config: ScoringConfig,
    reference_date: date,
) -> ScoreResult:
    """Score a single subscriber. Identical logic to CEDS score_row() with configurable weights.

    Always deterministic: same inputs + same reference_date = same output.
    Missing data is never penalised — scored 0 and recorded in data_gaps.
    """
    signals_fired: list[tuple[str, int, str]] = []
    data_gaps: list[str] = []
    tier_a_had_data = False
    tier_b_had_data = False

    linkedin_present = bool(
        record.li_current_employer_name
        or record.li_job_title
        or record.li_education_end_date
        or record.li_current_employer_domain
    )

    def run(pts: int, key: str, desc: str, tier: str) -> None:
        nonlocal tier_a_had_data, tier_b_had_data
        if "data_gap" in desc:
            data_gaps.append(desc)
            return
        if pts != 0 or key:
            if pts != 0:
                if tier == "A":
                    tier_a_had_data = True
                elif tier == "B":
                    tier_b_had_data = True
                signals_fired.append((key, pts, desc))
        if tier == "A" and desc and "data_gap" not in desc:
            tier_a_had_data = True
        if tier == "B" and desc and "data_gap" not in desc:
            tier_b_had_data = True

    run(*score_a1(record, config), "A")
    run(*score_a2(record, config, reference_date), "A")
    run(*score_a3(record, config), "A")
    run(*score_a4(record, config), "A")
    run(*score_b1(record, config), "B")
    run(*score_b2(record, config), "B")
    run(*score_b3(record, config), "B")

    if not linkedin_present:
        data_gaps.append("data_gap_linkedin")
    else:
        run(*score_c1(record, config), "C")
        run(*score_c2(record, config), "C")
        run(*score_c3(record, config, reference_date), "C")
        run(*score_c4(record, config), "C")

    # Post-processing: cap A2 at 5 pts when A1 fires at 180d+ level
    if any(key in _A1_STRONG_KEYS for key, _, _ in signals_fired):
        signals_fired = [
            (key, min(pts, 5) if key.startswith("A2_") else pts, desc)
            for key, pts, desc in signals_fired
        ]

    raw_score = sum(pts for _, pts, _ in signals_fired)
    total_score = max(0, min(100, raw_score))

    # Tier lookup
    confidence_tier = 0
    tier_label = "Likely Clean"
    recommended_action = "No Action"
    for lo, hi, tier_num, label, action in _TIER_MAP:
        if lo <= total_score <= hi:
            confidence_tier = tier_num
            tier_label = label
            recommended_action = action
            break

    # Data confidence
    if tier_a_had_data and tier_b_had_data:
        data_confidence = "high"
    elif tier_a_had_data or tier_b_had_data or len(signals_fired) >= 3:
        data_confidence = "medium"
    else:
        data_confidence = "low"

    # Primary and supporting signals
    primary_signal = ""
    supporting_signals = ""
    if signals_fired:
        sorted_sigs = sorted(signals_fired, key=lambda x: x[1], reverse=True)
        primary_signal = sorted_sigs[0][2]
        supporting = [s[2] for s in sorted_sigs[1:] if s[2]]
        supporting_signals = " | ".join(supporting)

    # AEC Professional Confirmed: C1 currently employed AND AEC keyword in title
    c1_active = any(k == "C1_currently_employed" for k, _, _ in signals_fired)
    title_lower = record.li_job_title.strip().lower()
    aec_match = any(kw in title_lower for kw in config.aec_professional_keywords)
    aec_professional_confirmed = c1_active and aec_match

    return ScoreResult(
        total_score=total_score,
        confidence_tier=confidence_tier,
        tier_label=tier_label,
        data_confidence=data_confidence,
        primary_signal=primary_signal,
        supporting_signals=supporting_signals,
        signals_count=len(signals_fired),
        signals_fired=", ".join(k for k, _, _ in signals_fired if k),
        data_gaps=", ".join(data_gaps),
        aec_professional_confirmed=aec_professional_confirmed,
        recommended_action=recommended_action,
        scoring_version=SCORING_VERSION,
    )


def score_batch(
    records: list[SubscriberRecord],
    config: ScoringConfig,
    reference_date: date,
) -> list[ScoreResult]:
    """Score a list of subscribers. Returns results in the same order as input."""
    return [score_row(r, config, reference_date) for r in records]
