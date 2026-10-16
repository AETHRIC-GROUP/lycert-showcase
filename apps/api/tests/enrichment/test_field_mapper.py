"""Unit tests for field_mapper.py.
All tests use fixture data only — no API calls, no database.
"""

from datetime import date
import pytest
from services.enrichment.field_mapper import (
    map_pdl_person,
    map_school_cleaner,
    map_location_cleaner,
    _extract_education_end_date,
    _parse_pdl_date,
    _primary_job,
)


# ── _parse_pdl_date ────────────────────────────────────────────────────────────

def test_parse_year_only():
    assert _parse_pdl_date("2023") == date(2023, 1, 1)

def test_parse_year_month():
    assert _parse_pdl_date("2023-06") == date(2023, 6, 1)

def test_parse_full_date():
    assert _parse_pdl_date("2023-06-15") == date(2023, 6, 15)

def test_parse_none():
    assert _parse_pdl_date(None) is None

def test_parse_empty():
    assert _parse_pdl_date("") is None

def test_parse_bad_value():
    assert _parse_pdl_date("not-a-date") is None


# ── _extract_education_end_date ────────────────────────────────────────────────

def test_edu_end_date_year_only_rounds_to_dec_31():
    edu = [{"school": {"name": "MIT"}, "end_date": "2023"}]
    result = _extract_education_end_date(edu)
    assert result == date(2023, 12, 31)

def test_edu_end_date_picks_latest():
    edu = [
        {"school": {"name": "MIT"}, "end_date": "2021-05"},
        {"school": {"name": "Harvard"}, "end_date": "2023-06"},
    ]
    result = _extract_education_end_date(edu)
    assert result == date(2023, 6, 1)

def test_edu_end_date_skips_missing():
    edu = [
        {"school": {"name": "MIT"}, "end_date": None},
        {"school": {"name": "Harvard"}, "end_date": "2022-05"},
    ]
    result = _extract_education_end_date(edu)
    assert result == date(2022, 5, 1)

def test_edu_end_date_all_missing_returns_none():
    edu = [{"school": {"name": "MIT"}}]
    result = _extract_education_end_date(edu)
    assert result is None

def test_edu_end_date_empty_list():
    assert _extract_education_end_date([]) is None


# ── _primary_job ───────────────────────────────────────────────────────────────

def test_primary_job_returns_is_primary():
    exp = [
        {"is_primary": False, "company": {"name": "Old Co"}},
        {"is_primary": True, "company": {"name": "Current Co"}},
    ]
    result = _primary_job(exp)
    assert result["company"]["name"] == "Current Co"

def test_primary_job_falls_back_to_first():
    exp = [
        {"is_primary": False, "company": {"name": "First Co"}},
        {"is_primary": False, "company": {"name": "Second Co"}},
    ]
    result = _primary_job(exp)
    assert result["company"]["name"] == "First Co"

def test_primary_job_empty_returns_none():
    assert _primary_job([]) is None


# ── map_pdl_person ─────────────────────────────────────────────────────────────

_FULL_PDL = {
    "id": "pdl_id_123",
    "linkedin_url": "linkedin.com/in/janesmith",
    "job_title": "junior architect",
    "job_title_levels": ["entry"],
    "job_company_name": "gensler berlin",
    "job_company_website": "gensler.com",
    "job_company_linkedin_url": "linkedin.com/company/gensler",
    "job_company_size": "10001+",
    "job_company_industry": "architecture & planning",
    "job_start_date": "2024-02",
    "location_country": "germany",
    "location_region": "berlin",
    "location_locality": "berlin",         # correct field name (not location_city)
    "skills": ["revit", "autocad", "the partner's visualizer", "the partner's renderer", "3d", "rhino", "lumion", "bim", "archicad", "grasshopper", "extra_skill"],
    "experience": [
        {
            "is_primary": True,
            "company": {"name": "gensler berlin", "website": "gensler.com"},
            "title": {"name": "junior architect"},
            "start_date": "2024-02",
            "end_date": None,
        }
    ],
    "education": [
        {
            "school": {"name": "university of stuttgart"},
            "degrees": ["bachelor of architecture"],
            "start_date": "2018",
            "end_date": "2023",
        }
    ],
}

def test_map_pdl_person_extracts_all_core_fields():
    record = map_pdl_person(_FULL_PDL, likelihood=8, subscriber_id="sub-1", tenant_id="t-1")
    assert record["pdl_person_id"] == "pdl_id_123"
    assert record["pdl_likelihood_score"] == 8
    assert record["li_job_title"] == "junior architect"
    assert record["li_current_employer_name"] == "gensler berlin"
    assert record["li_country"] == "germany"
    assert record["li_city"] == "berlin"             # maps to location_locality
    assert record["enrichment_provider"] == "pdl"
    assert record["subscriber_id"] == "sub-1"

def test_map_pdl_person_skills_capped_at_10():
    record = map_pdl_person(_FULL_PDL, likelihood=8, subscriber_id="sub-1", tenant_id="t-1")
    assert len(record["li_skills"]) == 10

def test_map_pdl_person_education_end_date_year_rounds_to_dec():
    record = map_pdl_person(_FULL_PDL, likelihood=8, subscriber_id="sub-1", tenant_id="t-1")
    assert record["li_education_end_date"] == date(2023, 12, 31)

def test_map_pdl_person_job_end_date_none_when_primary_current():
    record = map_pdl_person(_FULL_PDL, likelihood=8, subscriber_id="sub-1", tenant_id="t-1")
    assert record["li_job_end_date"] is None  # currently employed

def test_map_pdl_person_empty_experience():
    data = {**_FULL_PDL, "experience": []}
    record = map_pdl_person(data, likelihood=5, subscriber_id="sub-1", tenant_id="t-1")
    assert record["li_job_end_date"] is None

def test_map_pdl_person_missing_fields_are_none():
    record = map_pdl_person({}, likelihood=4, subscriber_id="sub-1", tenant_id="t-1")
    assert record["li_job_title"] is None
    assert record["li_country"] is None
    assert record["li_city"] is None
    assert record["pdl_person_id"] is None


# ── map_school_cleaner ─────────────────────────────────────────────────────────

def test_map_school_cleaner_extracts_country_from_location():
    """Country is at response.location.country, NOT at root level."""
    raw = {
        "name": "massachusetts institute of technology",
        "domain": "mit.edu",
        "location": {
            "country": "united states",
            "region": "massachusetts",
            "locality": "cambridge",
        },
    }
    result = map_school_cleaner(raw)
    assert result["institution_name_normalized"] == "massachusetts institute of technology"
    assert result["institution_domain_verified"] == "mit.edu"
    assert result["institution_country_normalized"] == "united states"
    assert result["institution_pdl_verified"] is True

def test_map_school_cleaner_missing_location():
    raw = {"name": "some school", "domain": None}
    result = map_school_cleaner(raw)
    assert result["institution_country_normalized"] is None
    assert result["institution_pdl_verified"] is True


# ── map_location_cleaner ───────────────────────────────────────────────────────

def test_map_location_cleaner():
    """Country is at root level in location cleaner response."""
    raw = {"country": "germany", "locality": "berlin", "region": "berlin"}
    result = map_location_cleaner(raw)
    assert result["account_country_normalized"] == "germany"

def test_map_location_cleaner_missing_country():
    result = map_location_cleaner({})
    assert result["account_country_normalized"] is None
