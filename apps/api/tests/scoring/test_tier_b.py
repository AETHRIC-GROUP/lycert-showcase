"""Unit tests for Tier B signals — user-submitted data."""
import pytest
from scoring.models import ScoringConfig, SubscriberRecord
from scoring.signals.tier_b import score_b1, score_b2, score_b3

CFG = ScoringConfig()


# ── B1 ─────────────────────────────────────────────────────────────────────────

def test_b1_personal_domain_scores():
    for domain in ["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com"]:
        r = SubscriberRecord(email=f"user@{domain}")
        pts, key, _ = score_b1(r, CFG)
        assert pts == 8, f"expected 8 for {domain}"
        assert key == "B1_personal_email"

def test_b1_academic_domain_exculpatory():
    for email in ["user@mit.edu", "u@ucl.ac.uk", "s@tu.university", "x@student.upc.edu"]:
        r = SubscriberRecord(email=email)
        pts, key, _ = score_b1(r, CFG)
        assert pts == -10, f"expected -10 for {email}"
        assert key == "B1_academic_email_exculpatory"

def test_b1_corporate_domain_no_signal():
    r = SubscriberRecord(email="user@design-partner.com")
    pts, key, _ = score_b1(r, CFG)
    assert pts == 0
    assert key == ""

def test_b1_missing_email_no_signal():
    r = SubscriberRecord(email="")
    pts, _, _ = score_b1(r, CFG)
    assert pts == 0

def test_b1_configurable_personal_weight():
    cfg = ScoringConfig(signal_b1_personal_weight=15)
    r = SubscriberRecord(email="user@gmail.com")
    pts, _, _ = score_b1(r, cfg)
    assert pts == 15

def test_b1_configurable_exculpatory():
    cfg = ScoringConfig(signal_b1_academic_exculpatory=-20)
    r = SubscriberRecord(email="user@mit.edu")
    pts, _, _ = score_b1(r, cfg)
    assert pts == -20


# ── B2 ─────────────────────────────────────────────────────────────────────────

def test_b2_institution_equals_account():
    r = SubscriberRecord(institution_name="Maria Garcia", account_name="Maria Garcia")
    pts, key, _ = score_b2(r, CFG)
    assert pts == 20
    assert key == "B2_institution_equals_account"

def test_b2_institution_equals_account_case_insensitive():
    r = SubscriberRecord(institution_name="maria garcia", account_name="Maria Garcia")
    pts, key, _ = score_b2(r, CFG)
    assert pts == 20
    assert key == "B2_institution_equals_account"

def test_b2_institution_missing():
    r = SubscriberRecord(institution_name="", account_name="Acme Corp")
    pts, key, _ = score_b2(r, CFG)
    assert pts == 15
    assert key == "B2_institution_missing"

def test_b2_institution_too_short():
    r = SubscriberRecord(institution_name="Uni", account_name="Acme Corp")
    pts, key, _ = score_b2(r, CFG)
    assert pts == 15
    assert key == "B2_institution_too_short"

def test_b2_valid_institution_no_signal():
    r = SubscriberRecord(institution_name="University of Manchester", account_name="Smith Architecture")
    pts, key, _ = score_b2(r, CFG)
    assert pts == 0
    assert key == ""


# ── B3 ─────────────────────────────────────────────────────────────────────────

def test_b3_country_mismatch():
    r = SubscriberRecord(
        institution_location="New York, United States",
        account_country="Germany",
    )
    pts, key, _ = score_b3(r, CFG)
    assert pts == 8
    assert key == "B3_country_mismatch"

def test_b3_countries_match_no_signal():
    r = SubscriberRecord(
        institution_location="Berlin, Germany",
        account_country="Germany",
    )
    pts, key, _ = score_b3(r, CFG)
    assert pts == 0

def test_b3_missing_fields_no_signal():
    r = SubscriberRecord(institution_location="", account_country="")
    pts, _, _ = score_b3(r, CFG)
    assert pts == 0

def test_b3_country_alias_usa():
    r = SubscriberRecord(
        institution_location="Boston, USA",
        account_country="Germany",
    )
    pts, key, _ = score_b3(r, CFG)
    assert pts == 8

def test_b3_country_alias_uk():
    """'UK' and 'United Kingdom' should normalise to the same country — no mismatch."""
    r = SubscriberRecord(
        institution_location="London, UK",
        account_country="United Kingdom",
    )
    pts, _, _ = score_b3(r, CFG)
    assert pts == 0

def test_b3_country_alias_czech_republic():
    """'Czech Republic' should normalise to 'czechia'."""
    r = SubscriberRecord(
        institution_location="Prague, Czech Republic",
        account_country="Czechia",
    )
    pts, _, _ = score_b3(r, CFG)
    assert pts == 0
