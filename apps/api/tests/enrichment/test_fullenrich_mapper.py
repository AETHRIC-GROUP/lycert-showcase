"""Mapper tests — FullEnrich webhook contact block (Part 1.6). Fixtures only.

Education coverage is provider-dependent; map what arrives, gap the rest.
"""

from services.enrichment.field_mapper import map_fullenrich_contact
from services.enrichment.providers.base import classify_completeness, ProviderOutcome


_CONTACT = {
    "firstname": "Jane",
    "lastname": "Smith",
    "linkedin_url": "https://linkedin.com/in/janesmith",
    "job_title": "Junior Architect",
    "company_name": "Gensler",
    "company_domain": "gensler.com",
    "location": "Berlin, Germany",
}


def test_full_contact_maps_core_fields():
    f = map_fullenrich_contact(_CONTACT)
    assert f["linkedin_profile_url"] == "https://linkedin.com/in/janesmith"
    assert f["li_job_title"] == "Junior Architect"
    assert f["li_current_employer_name"] == "Gensler"
    assert f["li_current_employer_domain"] == "gensler.com"
    assert f["li_city"] == "Berlin"
    assert f["li_country"] == "Germany"


def test_no_education_or_dates_is_partial():
    # FullEnrich contact carries no education/dates here → PARTIAL at best.
    assert classify_completeness(map_fullenrich_contact(_CONTACT)) == ProviderOutcome.PARTIAL


def test_missing_company_omits_employer_fields():
    contact = {"linkedin_url": "https://linkedin.com/in/x", "job_title": "Designer"}
    f = map_fullenrich_contact(contact)
    assert "li_current_employer_name" not in f
    assert f["li_job_title"] == "Designer"


def test_no_match_empty_contact_maps_to_empty():
    assert map_fullenrich_contact({}) == {}
    assert classify_completeness(map_fullenrich_contact({})) == ProviderOutcome.MISS


def test_country_only_location():
    f = map_fullenrich_contact({"location": "France"})
    assert f["li_country"] == "France"
    assert "li_city" not in f
