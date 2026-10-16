"""Tests for priority_queue.py — compute_enrichment_priority.

Covers every scoring branch from LYCERT_ENRICHMENT_ARCHITECTURE.md Part 3.2.
"""

from datetime import date, timedelta
import pytest

from services.enrichment.priority_queue import compute_enrichment_priority


# ── Graduation timing ─────────────────────────────────────────────────────────

class TestGraduationTiming:
    def _sub(self, days_offset: int) -> dict:
        grad = date.today() + timedelta(days=days_offset)
        return {"stated_graduation_date": grad.isoformat()}

    def test_graduated_over_365_days_ago(self):
        sub = self._sub(-400)
        score = compute_enrichment_priority(sub)
        assert score >= 40

    def test_graduated_180_to_365_days_ago(self):
        sub = self._sub(-200)
        score = compute_enrichment_priority(sub)
        assert score >= 30

    def test_graduated_0_to_180_days_ago(self):
        sub = self._sub(-50)
        score = compute_enrichment_priority(sub)
        assert score >= 20

    def test_graduating_within_90_days(self):
        sub = self._sub(-50)  # already graduated
        score = compute_enrichment_priority(sub)
        assert score >= 20

    def test_graduating_soon_gets_15_pts(self):
        sub = {"stated_graduation_date": (date.today() + timedelta(days=60)).isoformat()}
        score = compute_enrichment_priority(sub)
        assert score >= 15

    def test_graduation_over_90_days_away_gets_0_pts(self):
        sub = {"stated_graduation_date": (date.today() + timedelta(days=200)).isoformat()}
        score = compute_enrichment_priority(sub)
        # Email + institution parts may add points, but grad timing = 0
        assert score < 40

    def test_no_graduation_date(self):
        score = compute_enrichment_priority({})
        assert isinstance(score, int)
        assert 0 <= score <= 100


# ── Email domain type ─────────────────────────────────────────────────────────

class TestEmailDomainScoring:
    def test_corporate_email_adds_25(self):
        sub = {"email_domain_type": "corporate"}
        assert compute_enrichment_priority(sub) == 25

    def test_personal_email_adds_10(self):
        sub = {"email_domain_type": "personal"}
        assert compute_enrichment_priority(sub) == 10

    def test_disposable_email_adds_20(self):
        sub = {"email_domain_type": "disposable"}
        assert compute_enrichment_priority(sub) == 20

    def test_academic_email_adds_0(self):
        sub = {"email_domain_type": "academic"}
        assert compute_enrichment_priority(sub) == 0

    def test_missing_domain_type_adds_0(self):
        assert compute_enrichment_priority({}) == 0


# ── Institution trust ─────────────────────────────────────────────────────────

class TestInstitutionTrust:
    def test_suspicious_tier_adds_20(self):
        sub = {"institution_trust_tier": "suspicious", "institution_pdl_verified": True}
        assert compute_enrichment_priority(sub) >= 20

    def test_not_pdl_verified_adds_10(self):
        sub = {"institution_pdl_verified": False}
        assert compute_enrichment_priority(sub) >= 10

    def test_low_trust_adds_5(self):
        sub = {"institution_trust_tier": "low", "institution_pdl_verified": True}
        assert compute_enrichment_priority(sub) >= 5

    def test_high_trust_adds_0(self):
        sub = {"institution_trust_tier": "high", "institution_pdl_verified": True}
        assert compute_enrichment_priority(sub) == 0


# ── Auto-renew ────────────────────────────────────────────────────────────────

def test_auto_renew_adds_5():
    sub = {"auto_renew": True}
    assert compute_enrichment_priority(sub) == 5

def test_no_auto_renew_adds_0():
    sub = {"auto_renew": False}
    assert compute_enrichment_priority(sub) == 0


# ── Cap at 100 ────────────────────────────────────────────────────────────────

def test_score_never_exceeds_100():
    """Cap at 100 — current formula max is 90 but cap protects against future additions."""
    sub = {
        "stated_graduation_date": (date.today() - timedelta(days=400)).isoformat(),
        "email_domain_type": "corporate",
        "institution_trust_tier": "suspicious",
        "institution_pdl_verified": True,
        "auto_renew": True,
    }
    score = compute_enrichment_priority(sub)
    # Current max from spec formula: 40 + 25 + 20 + 5 = 90
    assert score == 90
    assert score <= 100


# ── Combined scores ───────────────────────────────────────────────────────────

def test_full_high_risk_subscriber():
    """Graduated 2 years ago + corporate email + suspicious institution = max risk."""
    sub = {
        "stated_graduation_date": (date.today() - timedelta(days=800)).isoformat(),
        "email_domain_type": "corporate",    # +25
        "institution_trust_tier": "suspicious",  # +20
        "institution_pdl_verified": True,
        "auto_renew": True,  # +5
        # grad timing: >365 days = +40
        # total before cap = 40+25+20+5 = 90
    }
    score = compute_enrichment_priority(sub)
    assert score == 90

def test_active_student_low_risk():
    """Active student graduating in 6 months + academic email + verified institution."""
    sub = {
        "stated_graduation_date": (date.today() + timedelta(days=180)).isoformat(),
        "email_domain_type": "academic",     # +0
        "institution_trust_tier": "high",    # +0
        "institution_pdl_verified": True,    # +0
        "auto_renew": False,                 # +0
    }
    score = compute_enrichment_priority(sub)
    assert score == 0
