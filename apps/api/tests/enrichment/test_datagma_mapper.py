"""Mapper tests — Datagma (Part 1.4). Fixtures only, no API calls.

Same positionHistory/educationHistory shape as ReverseContact, different root paths
(person.basic / person.details). Can be COMPLETE.
"""

from datetime import date

from services.enrichment.field_mapper import map_datagma_person
from services.enrichment.providers.base import classify_completeness, ProviderOutcome


_FULL = {
    "person": {
        "basic": {
            "fullName": "Jane Smith",
            "title": "Junior Architect",
            "linkedInUrl": "https://linkedin.com/in/janesmith",
            "location": "Berlin, Germany",
        },
        "details": {
            "positions": {"positionHistory": [
                {"title": "Junior Architect", "companyName": "Gensler",
                 "startEndDate": {"start": {"month": 3, "year": 2024}, "end": None}},
            ]},
            "schools": {"educationHistory": [
                {"schoolName": "University of Stuttgart", "degreeName": "B.Arch",
                 "startEndDate": {"start": {"year": 2018}, "end": {"year": 2023}}},
            ]},
        },
    },
    "company": {"basic": {"name": "Gensler", "website": "gensler.com",
                          "size": "5001-10000", "industry": "Architecture"}},
}


def test_full_response_maps_all_core_fields():
    f = map_datagma_person(_FULL)
    assert f["linkedin_profile_url"] == "https://linkedin.com/in/janesmith"
    assert f["li_job_title"] == "Junior Architect"
    assert f["li_current_employer_name"] == "Gensler"
    assert f["li_current_employer_domain"] == "gensler.com"
    assert f["li_employer_size"] == "5001-10000"      # provider-supplied band string
    assert f["li_employer_industry"] == "Architecture"
    assert f["li_job_start_date"] == date(2024, 3, 1)
    assert f["li_education_institution"] == "University of Stuttgart"
    assert f["li_education_end_date"] == date(2023, 12, 31)


def test_full_response_is_complete():
    assert classify_completeness(map_datagma_person(_FULL)) == ProviderOutcome.COMPLETE


def test_missing_education_is_partial():
    body = {"person": {**_FULL["person"], "details": {
        **_FULL["person"]["details"], "schools": {"educationHistory": []}}},
        "company": _FULL["company"]}
    f = map_datagma_person(body)
    assert "li_education_end_date" not in f
    assert classify_completeness(f) == ProviderOutcome.PARTIAL


def test_missing_dates_is_partial():
    details = {**_FULL["person"]["details"], "positions": {"positionHistory": [
        {"title": "Junior Architect", "companyName": "Gensler", "startEndDate": {}}]}}
    body = {"person": {**_FULL["person"], "details": details}, "company": _FULL["company"]}
    f = map_datagma_person(body)
    assert "li_job_start_date" not in f
    assert classify_completeness(f) == ProviderOutcome.PARTIAL


def test_no_match_maps_to_empty():
    assert map_datagma_person({}) == {}
    assert classify_completeness(map_datagma_person({})) == ProviderOutcome.MISS


def test_year_only_start_date_defaults_to_january():
    details = {**_FULL["person"]["details"], "positions": {"positionHistory": [
        {"title": "Architect", "companyName": "Gensler",
         "startEndDate": {"start": {"year": 2024}, "end": None}}]}}
    body = {"person": {**_FULL["person"], "details": details}, "company": _FULL["company"]}
    f = map_datagma_person(body)
    assert f["li_job_start_date"] == date(2024, 1, 1)
