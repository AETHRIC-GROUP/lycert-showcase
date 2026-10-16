"""Mapper tests — Hunter (Part 1.2). Fixtures only, no API calls.

Hunter returns NO education and NO employment dates → always PARTIAL, never COMPLETE.
"""

from datetime import date

from services.enrichment.field_mapper import map_hunter_person
from services.enrichment.providers.base import classify_completeness, ProviderOutcome


_FULL = {
    "name": {"fullName": "Jane Smith", "givenName": "Jane", "familyName": "Smith"},
    "email": "jane@example.com",
    "location": "Berlin, Germany",
    "geo": {"city": "berlin", "country": "DE"},
    "employment": {
        "domain": "gensler.com",
        "name": "Gensler",
        "title": "Junior Architect",
        "role": "design",
        "seniority": "junior",
    },
    "linkedin": {"handle": "in/janesmith"},
}


def test_full_response_maps_employment_and_linkedin():
    f = map_hunter_person(_FULL)
    assert f["li_current_employer_name"] == "Gensler"
    assert f["li_current_employer_domain"] == "gensler.com"
    assert f["li_job_title"] == "Junior Architect"
    assert f["li_job_title_levels"] == ["junior"]
    assert f["linkedin_profile_url"] == "https://linkedin.com/in/janesmith"
    assert f["li_country"] == "DE"


def test_full_response_is_partial_never_complete():
    # No education end date and no job start date → cannot be COMPLETE.
    assert classify_completeness(map_hunter_person(_FULL)) == ProviderOutcome.PARTIAL


def test_missing_education_and_dates_are_absent():
    f = map_hunter_person(_FULL)
    assert "li_education_end_date" not in f
    assert "li_education_institution" not in f
    assert "li_job_start_date" not in f


def test_no_linkedin_handle_omits_url():
    data = {**_FULL, "linkedin": {}}
    f = map_hunter_person(data)
    assert "linkedin_profile_url" not in f


def test_no_match_empty_data_maps_to_empty():
    assert map_hunter_person({}) == {}
    assert classify_completeness(map_hunter_person({})) == ProviderOutcome.MISS


def test_no_gdpr_fields_leak():
    # Even if Hunter returned excluded categories, the mapper must never surface them.
    data = {**_FULL, "gender": "female", "phone_number": "+49123", "photo": "http://x/p.jpg"}
    f = map_hunter_person(data)
    assert "gender" not in f and "phone_number" not in f and "photo" not in f
