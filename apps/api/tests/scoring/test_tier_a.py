"""Unit tests for Tier A signals — billing data."""
import pytest
from datetime import date
from scoring.models import ScoringConfig, SubscriberRecord
from scoring.signals.tier_a import score_a1, score_a2, score_a3, score_a4

REF = date(2026, 5, 26)
CFG = ScoringConfig()


# ── A1 ─────────────────────────────────────────────────────────────────────────

def test_a1_renewed_over_1yr_after_grad():
    r = SubscriberRecord(renewal_delta_days=-410)
    pts, key, _ = score_a1(r, CFG)
    assert pts == 35
    assert key == "A1_renewed_365d_after_grad"

def test_a1_renewed_180_365d_after_grad():
    r = SubscriberRecord(renewal_delta_days=-200)
    pts, key, _ = score_a1(r, CFG)
    assert pts == 30
    assert key == "A1_renewed_180d_after_grad"

def test_a1_renewed_90_180d_after_grad():
    r = SubscriberRecord(renewal_delta_days=-120)
    pts, key, _ = score_a1(r, CFG)
    assert pts == 25
    assert key == "A1_renewed_90d_after_grad"

def test_a1_renewed_0_90d_after_grad():
    r = SubscriberRecord(renewal_delta_days=-30)
    pts, key, _ = score_a1(r, CFG)
    assert pts == 15
    assert key == "A1_renewed_after_grad"

def test_a1_renewed_near_graduation():
    r = SubscriberRecord(renewal_delta_days=45)
    pts, key, _ = score_a1(r, CFG)
    assert pts == 5
    assert key == "A1_renewed_near_graduation"

def test_a1_renewed_well_before_graduation_no_signal():
    r = SubscriberRecord(renewal_delta_days=200)
    pts, key, _ = score_a1(r, CFG)
    assert pts == 0
    assert key == ""

def test_a1_missing_field_data_gap():
    r = SubscriberRecord(renewal_delta_days=None)
    pts, key, desc = score_a1(r, CFG)
    assert pts == 0
    assert "data_gap" in desc

def test_a1_configurable_weight():
    cfg = ScoringConfig(signal_a1_weight=70)
    r = SubscriberRecord(renewal_delta_days=-400)
    pts, _, _ = score_a1(r, cfg)
    assert pts == 70  # max tier


# ── A2 ─────────────────────────────────────────────────────────────────────────

def test_a2_graduated_over_1yr_ago():
    r = SubscriberRecord(stated_graduation_date=date(2025, 1, 1))
    pts, key, _ = score_a2(r, CFG, REF)
    assert pts == 20
    assert key == "A2_graduated_over_1yr_ago"

def test_a2_graduated_6_12mo_ago():
    r = SubscriberRecord(stated_graduation_date=date(2025, 11, 1))  # 207 days before REF
    pts, key, _ = score_a2(r, CFG, REF)
    assert pts == 15
    assert key == "A2_graduated_6_12mo_ago"

def test_a2_graduated_3_6mo_ago():
    r = SubscriberRecord(stated_graduation_date=date(2026, 2, 1))
    pts, key, _ = score_a2(r, CFG, REF)
    assert pts == 10
    assert key == "A2_graduated_3_6mo_ago"

def test_a2_graduated_recently():
    r = SubscriberRecord(stated_graduation_date=date(2026, 4, 1))
    pts, key, _ = score_a2(r, CFG, REF)
    assert pts == 5
    assert key == "A2_graduated_recently"

def test_a2_not_yet_graduated_no_signal():
    r = SubscriberRecord(stated_graduation_date=date(2027, 6, 1))
    pts, key, _ = score_a2(r, CFG, REF)
    assert pts == 0
    assert key == ""

def test_a2_missing_field_data_gap():
    r = SubscriberRecord(stated_graduation_date=None)
    pts, key, desc = score_a2(r, CFG, REF)
    assert pts == 0
    assert "data_gap" in desc

def test_a2_cap_when_a1_fires_strongly():
    """A2 is capped at 5 pts when A1 fires at 180d+ level (post-processing in engine)."""
    from scoring.engine import score_row
    r = SubscriberRecord(
        renewal_delta_days=-400,                   # A1 fires at max (35pts)
        stated_graduation_date=date(2024, 1, 1),   # A2 would be 20pts without cap
        institution_name="Valid University Name",  # suppress B2
    )
    result = score_row(r, CFG, REF)
    assert "A1_renewed_365d_after_grad" in result.signals_fired
    assert "A2_graduated_over_1yr_ago" in result.signals_fired
    # Without cap: A1(35) + A2(20) = 55. With cap: A1(35) + A2_capped(5) = 40.
    assert result.total_score == 40


# ── A3 ─────────────────────────────────────────────────────────────────────────

def test_a3_proof_predates_subscription():
    r = SubscriberRecord(
        proof_submission_date=date(2024, 1, 1),
        subscription_start_date=date(2024, 2, 15),
    )
    pts, key, _ = score_a3(r, CFG)
    assert pts == 20
    assert key == "A3_proof_predates_subscription"

def test_a3_proof_slightly_early():
    r = SubscriberRecord(
        proof_submission_date=date(2024, 2, 1),
        subscription_start_date=date(2024, 2, 15),
    )
    pts, key, _ = score_a3(r, CFG)
    assert pts == 5
    assert key == "A3_proof_slightly_early"

def test_a3_proof_after_subscription_no_signal():
    r = SubscriberRecord(
        proof_submission_date=date(2024, 3, 1),
        subscription_start_date=date(2024, 2, 15),
    )
    pts, key, _ = score_a3(r, CFG)
    assert pts == 0

def test_a3_missing_dates_no_signal():
    r = SubscriberRecord(proof_submission_date=None, subscription_start_date=None)
    pts, _, _ = score_a3(r, CFG)
    assert pts == 0


# ── A4 ─────────────────────────────────────────────────────────────────────────

def test_a4_subscription_over_2yrs():
    r = SubscriberRecord(
        subscription_start_date=date(2022, 1, 1),
        subscription_end_date=date(2024, 6, 1),
    )
    pts, key, _ = score_a4(r, CFG)
    assert pts == 10
    assert key == "A4_subscription_over_2yrs"

def test_a4_subscription_under_2yrs_no_signal():
    r = SubscriberRecord(
        subscription_start_date=date(2023, 1, 1),
        subscription_end_date=date(2024, 6, 1),
    )
    pts, _, _ = score_a4(r, CFG)
    assert pts == 0

def test_a4_missing_dates_no_signal():
    r = SubscriberRecord(subscription_start_date=None, subscription_end_date=None)
    pts, _, _ = score_a4(r, CFG)
    assert pts == 0
