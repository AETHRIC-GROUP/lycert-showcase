"""Merge engine tests — LYCERT_WATERFALL_ENRICHMENT_V2.md Part 5. Fixtures only.

Covers: first-written-wins, PDL education override, same-employer date completion,
different-employer block replacement, wrong-person guard (rule 4), provenance correctness.
"""

from datetime import date

from services.enrichment.merge import merge_fields, same_employer, names_overlap
from services.enrichment.providers.base import ProviderOutcome, ProviderResult


def _r(provider, fields, full_name=None, outcome=ProviderOutcome.PARTIAL):
    return ProviderResult(provider_key=provider, outcome=outcome, fields=fields, full_name=full_name)


def test_first_written_wins():
    merged, prov = {}, {}
    merge_fields(merged, prov, _r("hunter", {"li_job_title": "Junior Architect"}), "Jane Smith")
    merge_fields(merged, prov, _r("reversecontact", {"li_job_title": "Senior Architect"}), "Jane Smith")
    assert merged["li_job_title"] == "Junior Architect"   # earlier (cheaper) provider wins
    assert prov["li_job_title"] == "hunter"


def test_later_provider_fills_gaps_only():
    merged, prov = {}, {}
    merge_fields(merged, prov, _r("hunter", {"li_job_title": "Architect"}), "Jane Smith")
    merge_fields(merged, prov, _r("reversecontact",
        {"li_education_end_date": date(2023, 12, 31), "li_education_institution": "Stuttgart"}), "Jane Smith")
    assert merged["li_job_title"] == "Architect"
    assert merged["li_education_end_date"] == date(2023, 12, 31)
    assert prov["li_education_end_date"] == "reversecontact"


def test_pdl_education_overrides_earlier_provider():
    merged, prov = {}, {}
    merge_fields(merged, prov, _r("reversecontact",
        {"li_education_institution": "Online U", "li_education_end_date": date(2020, 12, 31)}), "Jane Smith")
    merge_fields(merged, prov, _r("pdl",
        {"li_education_institution": "University of Stuttgart", "li_education_end_date": date(2023, 12, 31)}), "Jane Smith")
    assert merged["li_education_institution"] == "University of Stuttgart"   # PDL overrides
    assert merged["li_education_end_date"] == date(2023, 12, 31)
    assert prov["li_education_end_date"] == "pdl"


def test_pdl_does_not_override_non_education_fields():
    merged, prov = {}, {}
    merge_fields(merged, prov, _r("hunter", {"li_job_title": "Architect"}), "Jane Smith")
    merge_fields(merged, prov, _r("pdl", {"li_job_title": "Designer"}), "Jane Smith")
    assert merged["li_job_title"] == "Architect"   # first-wins still applies outside education
    assert prov["li_job_title"] == "hunter"


def test_same_employer_date_completion():
    merged, prov = {}, {}
    merge_fields(merged, prov, _r("hunter",
        {"li_current_employer_name": "Gensler", "li_job_title": "Architect"}), "Jane Smith")
    merge_fields(merged, prov, _r("reversecontact",
        {"li_current_employer_name": "Gensler GmbH", "li_job_start_date": date(2024, 2, 1)}), "Jane Smith")
    # Same employer (after stripping GmbH): name kept from first, dates merged in.
    assert merged["li_current_employer_name"] == "Gensler"
    assert merged["li_job_start_date"] == date(2024, 2, 1)
    assert prov["li_current_employer_name"] == "hunter"
    assert prov["li_job_start_date"] == "reversecontact"


def test_different_employer_replaces_whole_block():
    merged, prov = {}, {}
    merge_fields(merged, prov, _r("hunter", {
        "li_current_employer_name": "OldCo", "li_current_employer_domain": "oldco.com",
        "li_job_title": "Intern"}), "Jane Smith")
    merge_fields(merged, prov, _r("datagma", {
        "li_current_employer_name": "NewCo", "li_current_employer_domain": "newco.com",
        "li_job_title": "Architect", "li_job_start_date": date(2024, 1, 1)}), "Jane Smith")
    # Fresher provider's full employment block replaces the earlier one.
    assert merged["li_current_employer_name"] == "NewCo"
    assert merged["li_current_employer_domain"] == "newco.com"
    assert merged["li_job_title"] == "Architect"
    assert merged["li_job_start_date"] == date(2024, 1, 1)
    assert prov["li_current_employer_name"] == "datagma"
    assert prov["li_job_title"] == "datagma"


def test_education_survives_different_employer_replacement():
    merged, prov = {}, {}
    merge_fields(merged, prov, _r("reversecontact", {
        "li_current_employer_name": "OldCo",
        "li_education_end_date": date(2023, 12, 31)}), "Jane Smith")
    merge_fields(merged, prov, _r("datagma", {"li_current_employer_name": "NewCo"}), "Jane Smith")
    assert merged["li_current_employer_name"] == "NewCo"
    assert merged["li_education_end_date"] == date(2023, 12, 31)   # education untouched
    assert prov["li_education_end_date"] == "reversecontact"


def test_wrong_person_guard_discards_result():
    merged, prov = {"li_job_title": "Architect"}, {"li_job_title": "hunter"}
    status = merge_fields(
        merged, prov,
        _r("reversecontact", {"li_job_title": "CEO", "li_current_employer_name": "Wrong"}, full_name="Bob Jones"),
        subscriber_name="Jane Smith",
    )
    assert status == "mismatch"
    assert merged == {"li_job_title": "Architect"}   # untouched
    assert "li_current_employer_name" not in merged


def test_name_overlap_allows_merge():
    merged, prov = {}, {}
    status = merge_fields(
        merged, prov,
        _r("reversecontact", {"li_job_title": "Architect"}, full_name="Jane A. Smith"),
        subscriber_name="Jane Smith",
    )
    assert status == "merged"
    assert merged["li_job_title"] == "Architect"


def test_missing_names_never_treated_as_mismatch():
    assert names_overlap(None, "Bob Jones") is True
    assert names_overlap("Jane Smith", None) is True


def test_same_employer_helper():
    assert same_employer("Gensler", "Gensler GmbH") is True
    assert same_employer("Gensler Inc.", "gensler") is True
    assert same_employer("Gensler", "Foster + Partners") is False


def test_empty_result_is_noop():
    merged, prov = {}, {}
    assert merge_fields(merged, prov, _r("hunter", {}), "Jane Smith") == "empty"
    assert merged == {}
