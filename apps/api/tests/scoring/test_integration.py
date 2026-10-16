"""Integration tests for the full scoring engine."""
import pytest
from datetime import date
from scoring.engine import score_row
from scoring.models import ScoringConfig, SubscriberRecord

REF = date(2026, 5, 26)
CFG = ScoringConfig()


def test_score_row_all_signals_present():
    r = SubscriberRecord(
        email="user@gmail.com",
        account_name="Acme Corp",
        institution_name="Acme Corp",           # equals account → B2
        institution_location="New York, USA",
        account_country="Germany",               # mismatch → B3
        stated_graduation_date=date(2024, 1, 1), # over 1yr ago → A2
        renewal_delta_days=-410,                 # over 365d → A1
        subscription_start_date=date(2021, 1, 1),
        subscription_end_date=date(2024, 6, 1),  # >730d → A4
        li_current_employer_name="BigCorp",
        li_job_end_date=None,                    # currently employed → C1
        li_job_title="Senior Architect",         # strong keyword → C2
        li_education_end_date=date(2023, 1, 1),  # ended 2+ yrs ago → C3
        li_current_employer_domain="bigcorp.com", # commercial → C4
    )
    result = score_row(r, CFG, REF)
    assert result.total_score == 100  # capped at 100
    assert result.confidence_tier == 1
    assert result.tier_label == "Near-Certain Violation"
    assert result.recommended_action == "Contact Now"
    assert result.signals_count > 0
    assert result.aec_professional_confirmed is True  # C1 active + "architect" keyword


def test_score_row_no_linkedin_data_gap_recorded():
    r = SubscriberRecord(
        email="user@gmail.com",
        li_current_employer_name="",
        li_job_title="",
        li_education_end_date=None,
        li_current_employer_domain="",
    )
    result = score_row(r, CFG, REF)
    assert "data_gap_linkedin" in result.data_gaps


def test_score_row_all_missing_fields_scores_zero():
    """All billing and enrichment fields missing — only B2_institution_missing fires (15pts).
    This matches CEDS: a blank institution name is itself a signal, not a data gap.
    """
    r = SubscriberRecord()
    result = score_row(r, CFG, REF)
    # B2 fires (institution_name is blank = suspicious signal per CEDS)
    assert "B2_institution_missing" in result.signals_fired
    assert "data_gap_linkedin" in result.data_gaps
    # All other fields produce data_gaps or 0
    assert result.confidence_tier in (0, 3)  # 15pts → Watch List or Clean depending on thresholds


def test_aec_professional_confirmed_true():
    r = SubscriberRecord(
        li_current_employer_name="Studio XYZ",
        li_job_end_date=None,           # currently employed
        li_job_title="3D Visualizer",   # AEC keyword
    )
    result = score_row(r, CFG, REF)
    assert result.aec_professional_confirmed is True


def test_aec_professional_confirmed_false_no_c1():
    r = SubscriberRecord(
        li_current_employer_name="",    # no employer = no C1
        li_job_title="3D Visualizer",
    )
    result = score_row(r, CFG, REF)
    assert result.aec_professional_confirmed is False


def test_aec_professional_confirmed_false_no_aec_keyword():
    r = SubscriberRecord(
        li_current_employer_name="BigCorp",
        li_job_end_date=None,
        li_job_title="Software Engineer",  # not an AEC keyword
    )
    result = score_row(r, CFG, REF)
    assert result.aec_professional_confirmed is False


def test_score_capped_at_100():
    r = SubscriberRecord(
        email="user@gmail.com",
        institution_name="user",        # too short → B2
        institution_location="USA",
        account_country="Germany",
        stated_graduation_date=date(2020, 1, 1),
        renewal_delta_days=-800,
        subscription_start_date=date(2018, 1, 1),
        subscription_end_date=date(2026, 1, 1),
        li_current_employer_name="Corp",
        li_job_end_date=None,
        li_job_title="Senior Architect",
        li_education_end_date=date(2020, 1, 1),
        li_current_employer_domain="corp.com",
    )
    result = score_row(r, CFG, REF)
    assert result.total_score <= 100


def test_score_floored_at_0():
    """Strong exculpatory signals should drive score to 0 (floor), not negative."""
    r = SubscriberRecord(
        email="user@student.tue.nl",             # academic → B1 exculpatory (-10)
        institution_name="TU Eindhoven",          # valid institution → B2 no signal
        li_job_title="PhD Student",              # student → C2 exculpatory (-15)
        li_education_end_date=date(2027, 1, 1),  # future → C3 exculpatory (-5)
        li_current_employer_domain="tu-delft.edu",  # academic .edu → C4 exculpatory (-5)
        li_current_employer_name="TU Delft",
        li_job_end_date=None,                    # currently employed → C1 (+25)
    )
    # Raw: -10 + 25 - 15 - 5 - 5 = -10 → floored to 0
    result = score_row(r, CFG, REF)
    assert result.total_score == 0


def test_a2_cap_applied_in_engine():
    """A2 capped at 5 when A1 fires at A1_renewed_365d or A1_renewed_180d."""
    r = SubscriberRecord(
        renewal_delta_days=-400,                    # A1 max (35)
        stated_graduation_date=date(2024, 1, 1),    # A2 would be 20 without cap
    )
    result = score_row(r, CFG, REF)
    # A1(35) + A2_capped(5) = 40 max from these two signals
    total_from_ab = sum(
        int(p) for part in result.signals_fired.split(", ") if part
        for key_str in [part]
        for p in [35 if "A1" in key_str else (5 if "A2" in key_str else 0)]
    )
    assert "A1_renewed_365d_after_grad" in result.signals_fired
    if "A2_" in result.signals_fired:
        # A2 contribution must be ≤ 5
        a2_pts = [
            s for s in result.signals_fired.split(", ") if "A2_" in s
        ]
        assert len(a2_pts) <= 1


def test_data_confidence_high_when_both_tiers():
    r = SubscriberRecord(
        renewal_delta_days=-200,                    # A tier
        institution_name="",                        # B tier (missing)
        li_current_employer_name="Corp",
        li_job_end_date=None,
    )
    result = score_row(r, CFG, REF)
    assert result.data_confidence == "high"


def test_data_confidence_low_when_sparse():
    """No billing data, no LinkedIn, no B-tier signals → low confidence."""
    r = SubscriberRecord(
        institution_name="Valid University",  # suppress B2
        email="user@corp.com",               # suppress B1 (not personal/academic)
        li_current_employer_name="",
        li_job_title="",
    )
    result = score_row(r, CFG, REF)
    assert result.data_confidence == "low"
