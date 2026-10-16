"""Unit tests for Tier C signals — LinkedIn enrichment data."""
import pytest
from datetime import date
from scoring.models import ScoringConfig, SubscriberRecord
from scoring.signals.tier_c import score_c1, score_c2, score_c3, score_c4

REF = date(2026, 5, 26)
CFG = ScoringConfig()


# ── C1 ─────────────────────────────────────────────────────────────────────────

def test_c1_currently_employed():
    r = SubscriberRecord(li_current_employer_name="Deloitte", li_job_end_date=None)
    pts, key, desc = score_c1(r, CFG)
    assert pts == 25
    assert key == "C1_currently_employed"
    assert "Deloitte" in desc

def test_c1_previously_employed():
    r = SubscriberRecord(
        li_current_employer_name="OldCorp",
        li_job_end_date=date(2024, 6, 1),
    )
    pts, key, _ = score_c1(r, CFG)
    assert pts == 5
    assert key == "C1_previously_employed"

def test_c1_no_company_data():
    r = SubscriberRecord(li_current_employer_name="")
    pts, key, _ = score_c1(r, CFG)
    assert pts == 0
    assert key == ""


# ── C2 ─────────────────────────────────────────────────────────────────────────

def test_c2_strong_professional_keyword():
    for title in ["Senior Architect", "Director of Design", "CEO", "Freelance Designer"]:
        r = SubscriberRecord(li_job_title=title)
        pts, key, _ = score_c2(r, CFG)
        assert pts == 20, f"expected 20 for '{title}'"
        assert key == "C2_professional_title_strong"

def test_c2_weak_professional_keyword():
    for title in ["Software Engineer", "Design Consultant", "Data Analyst"]:
        r = SubscriberRecord(li_job_title=title)
        pts, key, _ = score_c2(r, CFG)
        assert pts == 10, f"expected 10 for '{title}'"
        assert key == "C2_professional_title_weak"

def test_c2_student_keyword_exculpatory():
    for title in ["PhD Student", "Graduate Student", "Research Intern", "MSc Student"]:
        r = SubscriberRecord(li_job_title=title)
        pts, key, _ = score_c2(r, CFG)
        assert pts == -15, f"expected -15 for '{title}'"
        assert key == "C2_student_title_exculpatory"

def test_c2_student_keyword_takes_priority_over_professional():
    """'Senior PhD Student' — student keyword wins over 'senior' (strong)."""
    r = SubscriberRecord(li_job_title="Senior PhD Student")
    pts, key, _ = score_c2(r, CFG)
    assert pts == -15
    assert key == "C2_student_title_exculpatory"

def test_c2_no_keyword_match():
    r = SubscriberRecord(li_job_title="Barista")
    pts, key, _ = score_c2(r, CFG)
    assert pts == 0
    assert key == ""

def test_c2_empty_title_no_signal():
    r = SubscriberRecord(li_job_title="")
    pts, _, _ = score_c2(r, CFG)
    assert pts == 0


# ── C3 ─────────────────────────────────────────────────────────────────────────

def test_c3_education_ended_2yr_plus():
    r = SubscriberRecord(li_education_end_date=date(2023, 1, 1))  # < 2025 (this_year-1)
    pts, key, _ = score_c3(r, CFG, REF)
    assert pts == 15
    assert key == "C3_education_ended"

def test_c3_education_ended_last_year():
    r = SubscriberRecord(li_education_end_date=date(2025, 1, 1))  # == this_year-1
    pts, key, _ = score_c3(r, CFG, REF)
    assert pts == 10
    assert key == "C3_education_ended_last_year"

def test_c3_graduating_this_year_no_signal():
    r = SubscriberRecord(li_education_end_date=date(2026, 1, 1))  # == this_year
    pts, key, _ = score_c3(r, CFG, REF)
    assert pts == 0
    assert key == ""

def test_c3_future_graduation_exculpatory():
    r = SubscriberRecord(li_education_end_date=date(2027, 1, 1))  # > this_year
    pts, key, _ = score_c3(r, CFG, REF)
    assert pts == -5
    assert key == "C3_future_graduation_exculpatory"

def test_c3_missing_date_no_signal():
    r = SubscriberRecord(li_education_end_date=None)
    pts, _, _ = score_c3(r, CFG, REF)
    assert pts == 0


# ── C4 ─────────────────────────────────────────────────────────────────────────

def test_c4_commercial_employer():
    r = SubscriberRecord(li_current_employer_domain="deloitte.com")
    pts, key, _ = score_c4(r, CFG)
    assert pts == 10
    assert key == "C4_commercial_employer"

def test_c4_academic_employer_exculpatory():
    for domain in ["mit.edu", "ucl.ac.uk", "tu-berlin.university", "oxford.college"]:
        r = SubscriberRecord(li_current_employer_domain=domain)
        pts, key, _ = score_c4(r, CFG)
        assert pts == -5, f"expected -5 for {domain}"
        assert key == "C4_academic_employer_exculpatory"

def test_c4_missing_domain_no_signal():
    r = SubscriberRecord(li_current_employer_domain="")
    pts, key, _ = score_c4(r, CFG)
    assert pts == 0
    assert key == ""
