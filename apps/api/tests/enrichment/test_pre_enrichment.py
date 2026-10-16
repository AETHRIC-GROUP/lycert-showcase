"""Tests for email domain classification and pre-enrichment logic.
All external API calls mocked.
"""

import pytest
from unittest.mock import AsyncMock, patch

from services.enrichment.pre_enrichment import classify_email_domain, run_pre_enrichment


# ── classify_email_domain ─────────────────────────────────────────────────────

class TestEmailDomainClassification:
    def test_edu_tld(self):
        assert classify_email_domain("student@mit.edu") == "academic"

    def test_ac_uk_tld(self):
        assert classify_email_domain("student@ox.ac.uk") == "academic"

    def test_ac_jp_tld(self):
        assert classify_email_domain("student@u-tokyo.ac.jp") == "academic"

    def test_german_uni_subdomain(self):
        assert classify_email_domain("student@uni-berlin.de") == "academic"

    def test_german_fh(self):
        assert classify_email_domain("student@fh-aachen.de") == "academic"

    def test_verified_institution_domain_match(self):
        assert classify_email_domain("jane@mit.edu", institution_domain_verified="mit.edu") == "academic"

    def test_personal_gmail(self):
        assert classify_email_domain("user@gmail.com") == "personal"

    def test_personal_yahoo(self):
        assert classify_email_domain("user@yahoo.com") == "personal"

    def test_personal_icloud(self):
        assert classify_email_domain("user@icloud.com") == "personal"

    def test_personal_protonmail(self):
        assert classify_email_domain("user@protonmail.com") == "personal"

    def test_disposable(self):
        assert classify_email_domain("user@mailinator.com") == "disposable"

    def test_corporate_default(self):
        assert classify_email_domain("user@acmecorp.com") == "corporate"

    def test_no_at_sign(self):
        assert classify_email_domain("notanemail") == "corporate"

    def test_empty_string(self):
        assert classify_email_domain("") == "corporate"

    def test_institution_domain_takes_priority_over_personal(self):
        # If school happened to have a gmail.com domain (unlikely but defensive)
        assert classify_email_domain("user@gmail.com", institution_domain_verified="gmail.com") == "academic"


# ── run_pre_enrichment ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_run_pre_enrichment_school_found():
    school_raw = {
        "name": "massachusetts institute of technology",
        "domain": "mit.edu",
        "location": {"country": "united states", "region": "massachusetts"},
    }
    with patch(
        "services.enrichment.pre_enrichment.clean_school",
        AsyncMock(return_value=school_raw),
    ), patch(
        "services.enrichment.pre_enrichment.clean_location",
        AsyncMock(return_value=None),
    ):
        result = await run_pre_enrichment({
            "email": "student@mit.edu",
            "institution_name": "MIT",
        })

    assert result["institution_name_normalized"] == "massachusetts institute of technology"
    assert result["institution_domain_verified"] == "mit.edu"
    assert result["institution_country_normalized"] == "united states"
    assert result["institution_pdl_verified"] is True
    assert result["email_domain_type"] == "academic"


@pytest.mark.asyncio
async def test_run_pre_enrichment_school_not_found():
    with patch(
        "services.enrichment.pre_enrichment.clean_school",
        AsyncMock(return_value=None),
    ), patch(
        "services.enrichment.pre_enrichment.clean_location",
        AsyncMock(return_value=None),
    ):
        result = await run_pre_enrichment({
            "email": "student@gmail.com",
            "institution_name": "Unknown Bootcamp",
        })

    assert result["institution_pdl_verified"] is False
    assert result["email_domain_type"] == "personal"


@pytest.mark.asyncio
async def test_run_pre_enrichment_location_normalised():
    with patch(
        "services.enrichment.pre_enrichment.clean_school",
        AsyncMock(return_value=None),
    ), patch(
        "services.enrichment.pre_enrichment.clean_location",
        AsyncMock(return_value={"country": "germany", "locality": "berlin"}),
    ):
        result = await run_pre_enrichment({
            "email": "student@corporateco.com",
            "institution_name": None,
            "account_location": "Berlin, Germany",
        })

    assert result["account_country_normalized"] == "germany"
    assert result["email_domain_type"] == "corporate"


@pytest.mark.asyncio
async def test_run_pre_enrichment_api_error_does_not_raise():
    """API failure must not raise — returns partial result."""
    with patch(
        "services.enrichment.pre_enrichment.clean_school",
        AsyncMock(side_effect=Exception("network error")),
    ), patch(
        "services.enrichment.pre_enrichment.clean_location",
        AsyncMock(return_value=None),
    ):
        result = await run_pre_enrichment({
            "email": "user@company.com",
            "institution_name": "Some University",
        })

    assert result["institution_pdl_verified"] is False
    assert "email_domain_type" in result


@pytest.mark.asyncio
async def test_run_pre_enrichment_institution_location_called():
    """Location Cleaner is called for institution_location (spec 1.7 ×2 call)."""
    location_calls: list[str] = []

    async def mock_clean_location(loc: str) -> dict | None:
        location_calls.append(loc)
        return {"country": "germany"} if "germany" in loc.lower() else {"country": "united states"}

    with patch("services.enrichment.pre_enrichment.clean_school", AsyncMock(return_value=None)), \
         patch("services.enrichment.pre_enrichment.clean_location", side_effect=mock_clean_location):
        result = await run_pre_enrichment({
            "email": "student@company.com",
            "account_location": "New York, USA",
            "institution_location": "Stuttgart, Germany",
        })

    # Both locations should be called
    assert len(location_calls) == 2
    assert any("New York" in c for c in location_calls)
    assert any("Stuttgart" in c for c in location_calls)
    assert result["account_country_normalized"] == "united states"
    assert result["institution_country_normalized"] == "germany"


@pytest.mark.asyncio
async def test_run_pre_enrichment_school_upserts_institution():
    """School Cleaner hit triggers institutions table upsert (spec 1.6 step 4)."""
    school_raw = {
        "display_name": "University of Stuttgart",
        "domain": "uni-stuttgart.de",
        "country": "germany",
        "type": "university",
    }
    upserted: list[dict] = []

    class MockDB:
        def table(self, name):
            return self

        def select(self, *a, **kw):
            return self

        def eq(self, *a, **kw):
            return self

        def maybe_single(self):
            return self

        def execute(self):
            from unittest.mock import MagicMock
            m = MagicMock()
            m.data = None  # simulate no existing record
            return m

        def insert(self, fields):
            upserted.append(fields)
            return self

    with patch("services.enrichment.pre_enrichment.clean_school", AsyncMock(return_value=school_raw)), \
         patch("services.enrichment.pre_enrichment.clean_location", AsyncMock(return_value=None)):
        result = await run_pre_enrichment(
            {"email": "student@uni-stuttgart.de", "institution_name": "Uni Stuttgart"},
            db=MockDB(),
        )

    assert result["institution_name_normalized"] == "University of Stuttgart"
    assert result["institution_domain_verified"] == "uni-stuttgart.de"
    assert len(upserted) == 1
    assert upserted[0]["domain"] == "uni-stuttgart.de"
    assert upserted[0]["source"] == "pdl_school_cleaner"


@pytest.mark.asyncio
async def test_run_pre_enrichment_returns_enrichment_priority():
    """compute_enrichment_priority is called and stored (spec Part 3.2)."""
    from datetime import date, timedelta
    school_raw = {"name": "MIT", "domain": "mit.edu", "location": {"country": "united states"}}
    sub = {
        "email": "student@gmail.com",
        "institution_name": "MIT",
        "stated_graduation_date": (date.today() - timedelta(days=400)).isoformat(),
        "email_domain_type": None,  # will be set by pre_enrichment
        "auto_renew": True,
    }
    with patch("services.enrichment.pre_enrichment.clean_school", AsyncMock(return_value=school_raw)), \
         patch("services.enrichment.pre_enrichment.clean_location", AsyncMock(return_value=None)):
        result = await run_pre_enrichment(sub)

    assert "enrichment_priority" in result
    assert isinstance(result["enrichment_priority"], int)
    assert 0 <= result["enrichment_priority"] <= 100


@pytest.mark.asyncio
async def test_run_pre_enrichment_display_name_used():
    """display_name is preferred over name for institution_name_normalized (spec 1.6)."""
    school_raw = {
        "name": "massachusetts institute of technology",
        "display_name": "Massachusetts Institute of Technology",
        "domain": "mit.edu",
        "location": {"country": "united states"},
    }
    with patch("services.enrichment.pre_enrichment.clean_school", AsyncMock(return_value=school_raw)), \
         patch("services.enrichment.pre_enrichment.clean_location", AsyncMock(return_value=None)):
        result = await run_pre_enrichment({"email": "s@mit.edu", "institution_name": "MIT"})

    assert result["institution_name_normalized"] == "Massachusetts Institute of Technology"
