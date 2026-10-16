"""Mapper tests — ReverseContact (Part 1.3). Fixtures only, no API calls.

ReverseContact returns education + dates → can be COMPLETE.
"""

from datetime import date

from services.enrichment.field_mapper import map_reversecontact_person
from services.enrichment.providers.base import classify_completeness, ProviderOutcome


_FULL = {
    "success": True,
    "email": "jane@example.com",
    "person": {
        "firstName": "Jane",
        "lastName": "Smith",
        "headline": "Junior Architect at Gensler",
        "location": "Berlin, Germany",
        "linkedInUrl": "https://linkedin.com/in/janesmith",
        "positions": {
            "positionsCount": 2,
            "positionHistory": [
                {
                    "title": "Junior Architect",
                    "companyName": "Gensler",
                    "companyLocation": "Berlin, Germany",
                    "startEndDate": {"start": {"month": 2, "year": 2024}, "end": None},
                },
                {
                    "title": "Intern",
                    "companyName": "SmallStudio",
                    "startEndDate": {"start": {"month": 6, "year": 2022}, "end": {"month": 1, "year": 2024}},
                },
            ],
        },
        "schools": {
            "educationsCount": 1,
            "educationHistory": [
                {
                    "schoolName": "University of Stuttgart",
                    "degreeName": "Bachelor of Architecture",
                    "fieldOfStudy": "Architecture",
                    "startEndDate": {"start": {"year": 2018}, "end": {"year": 2023}},
                }
            ],
        },
    },
    "company": {
        "name": "Gensler",
        "websiteUrl": "gensler.com",
        "industry": "Architecture & Planning",
        "employeeCount": 6000,
    },
}


def test_full_response_maps_all_core_fields():
    f = map_reversecontact_person(_FULL)
    assert f["linkedin_profile_url"] == "https://linkedin.com/in/janesmith"
    assert f["li_job_title"] == "Junior Architect"            # current = end=None entry
    assert f["li_current_employer_name"] == "Gensler"
    assert f["li_current_employer_domain"] == "gensler.com"
    assert f["li_employer_industry"] == "Architecture & Planning"
    assert f["li_employer_size"] == "5001-10000"               # 6000 → band
    assert f["li_job_start_date"] == date(2024, 2, 1)
    assert "li_job_end_date" not in f                          # end=None → currently employed
    assert f["li_education_institution"] == "University of Stuttgart"
    assert f["li_education_end_date"] == date(2023, 12, 31)    # year-only → Dec 31
    assert f["li_city"] == "Berlin"
    assert f["li_country"] == "Germany"


def test_full_response_is_complete():
    assert classify_completeness(map_reversecontact_person(_FULL)) == ProviderOutcome.COMPLETE


def test_missing_education_downgrades_to_partial():
    body = {**_FULL, "person": {**_FULL["person"], "schools": {"educationHistory": []}}}
    f = map_reversecontact_person(body)
    assert "li_education_end_date" not in f
    assert classify_completeness(f) == ProviderOutcome.PARTIAL


def test_missing_dates_downgrades_to_partial():
    person = {**_FULL["person"], "positions": {"positionHistory": [
        {"title": "Junior Architect", "companyName": "Gensler", "startEndDate": {}},
    ]}}
    f = map_reversecontact_person({**_FULL, "person": person})
    assert "li_job_start_date" not in f
    assert classify_completeness(f) == ProviderOutcome.PARTIAL


def test_no_match_maps_to_empty():
    assert map_reversecontact_person({"success": False}) == {}
    assert classify_completeness(map_reversecontact_person({"success": False})) == ProviderOutcome.MISS


def test_year_only_start_date_defaults_to_january():
    person = {**_FULL["person"], "positions": {"positionHistory": [
        {"title": "Architect", "companyName": "Gensler", "startEndDate": {"start": {"year": 2024}, "end": None}},
    ]}}
    f = map_reversecontact_person({**_FULL, "person": person})
    assert f["li_job_start_date"] == date(2024, 1, 1)
