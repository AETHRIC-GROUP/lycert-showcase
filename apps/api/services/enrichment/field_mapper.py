"""PDL JSON → Lycert subscriber_enrichment schema mapper.

Field name corrections vs architecture doc (verified against official PDL schema):
  - city field: data.location_locality  (NOT data.location_city)
  - PDL person ID: data.id              (NOT data.pdl_id)
  - experience title: exp.title.name    (title is an object, not a string)
  - company enrichment: response root   (NOT response.data — no data wrapper)

Raw PDL response is NEVER stored. Only the extracted fields below are persisted.
"""

from datetime import date, timedelta
from typing import Any


def map_pdl_person(
    pdl_data: dict[str, Any],
    likelihood: int,
    subscriber_id: str,
    tenant_id: str,
) -> dict[str, Any]:
    """Map raw PDL person.data dict to subscriber_enrichment insert record."""
    primary_job = _primary_job(pdl_data.get("experience") or [])
    edu_end_date = _extract_education_end_date(pdl_data.get("education") or [])
    edu_institution = _latest_education_institution(pdl_data.get("education") or [])
    now_str = "now()"
    delete_at = _delete_at_str()

    return {
        "subscriber_id": subscriber_id,
        "tenant_id": tenant_id,
        "pdl_person_id": pdl_data.get("id"),                    # data.id
        "pdl_likelihood_score": likelihood,
        "linkedin_profile_url": pdl_data.get("linkedin_url"),
        "li_job_title": pdl_data.get("job_title"),
        "li_job_title_levels": pdl_data.get("job_title_levels"),
        "li_current_employer_name": pdl_data.get("job_company_name"),
        "li_current_employer_domain": pdl_data.get("job_company_website"),
        "li_current_employer_linkedin_url": pdl_data.get("job_company_linkedin_url"),
        "li_employer_size": pdl_data.get("job_company_size"),
        "li_employer_industry": pdl_data.get("job_company_industry"),
        "li_job_start_date": _parse_pdl_date(pdl_data.get("job_start_date")),
        "li_job_end_date": _parse_pdl_date(primary_job.get("end_date")) if primary_job else None,
        "li_education_institution": edu_institution,
        "li_education_end_date": edu_end_date,
        "li_country": pdl_data.get("location_country"),
        "li_state": pdl_data.get("location_region"),
        "li_city": pdl_data.get("location_locality"),            # corrected: locality not city
        "li_skills": (pdl_data.get("skills") or [])[:10],
        "enrichment_provider": "pdl",
        # Note: enriched_at and delete_at set by orchestrator with real datetimes
    }


def _primary_job(experience: list[dict]) -> dict | None:
    """Return the primary (current) job entry from experience array."""
    for exp in experience:
        if exp.get("is_primary"):
            return exp
    return experience[0] if experience else None


def _extract_education_end_date(education: list[dict]) -> date | None:
    """Return latest education end_date across all entries.
    Handles partial dates: '2023' → 2023-12-31, '2023-06' → 2023-06-28.
    Conservative rounding for C3 signal accuracy.
    """
    dates: list[date] = []
    for entry in education:
        parsed = _parse_pdl_date(entry.get("end_date"))
        if parsed:
            # Year-only dates: round to Dec 31 (conservative — later = safer)
            if len(str(entry.get("end_date", ""))) == 4:
                parsed = parsed.replace(month=12, day=31)
            dates.append(parsed)
    return max(dates) if dates else None


def _latest_education_institution(education: list[dict]) -> str | None:
    """Return school name from the most recent education entry."""
    if not education:
        return None
    with_end = sorted(
        [e for e in education if e.get("end_date")],
        key=lambda x: x.get("end_date", ""),
        reverse=True,
    )
    source = with_end[0] if with_end else education[0]
    return (source.get("school") or {}).get("name")


def _parse_pdl_date(date_str: str | None) -> date | None:
    """Parse PDL date format (YYYY, YYYY-MM, or YYYY-MM-DD) to Python date."""
    if not date_str:
        return None
    try:
        s = str(date_str).strip()
        if len(s) == 4:
            return date(int(s), 1, 1)
        if len(s) == 7:
            y, m = s.split("-")
            return date(int(y), int(m), 1)
        if len(s) == 10:
            return date.fromisoformat(s)
    except (ValueError, TypeError):
        pass
    return None


def _delete_at_str() -> str:
    """ISO timestamp 30 days from now for enrichment retention."""
    from datetime import datetime, timezone, timedelta
    return (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()


def map_school_cleaner(raw: dict[str, Any]) -> dict[str, Any]:
    """Map PDL School Cleaner response to subscriber pre-enrichment fields.

    Architecture doc 1.6: store display_name as institution_name_normalized.
    Country: try root level first (architecture doc shape), then location sub-object
    (verified API schema shape) — handles both response variants.
    """
    location = raw.get("location") or {}
    country = raw.get("country") or location.get("country")
    normalized_name = raw.get("display_name") or raw.get("name")
    return {
        "institution_name_normalized": normalized_name,
        "institution_domain_verified": raw.get("domain"),
        "institution_country_normalized": country,
        "institution_pdl_verified": True,
    }


def map_school_cleaner_for_institutions(raw: dict[str, Any]) -> dict[str, Any]:
    """Extract fields for upserting an institutions table record from School Cleaner response.
    Called by pre_enrichment.py after a successful School Cleaner hit (spec 1.6 step 4).
    """
    location = raw.get("location") or {}
    country = raw.get("country") or location.get("country")
    school_type = raw.get("type") or ""

    type_map = {
        "university": "research_university",
        "college": "teaching_university",
        "community_college": "community_college",
        "vocational": "vocational",
        "bootcamp": "bootcamp",
        "online": "online_only",
    }

    return {
        "name": raw.get("display_name") or raw.get("name"),
        "domain": raw.get("domain"),
        "country": country,
        "institution_type": type_map.get(school_type, "unknown"),
        "source": "pdl_school_cleaner",
        "trust_tier": "medium",
        "degree_granting": school_type in ("university", "college", "community_college"),
    }


def map_location_cleaner(raw: dict[str, Any]) -> dict[str, Any]:
    """Map PDL Location Cleaner response to subscriber pre-enrichment fields.

    Location Cleaner response shape (verified):
      {name, locality, region, subregion, country, continent, type, geo}
    Country is at root level.
    """
    return {
        "account_country_normalized": raw.get("country"),
    }


# ── V2 waterfall: shared LinkedIn-style profile mapper ────────────────────────
# LYCERT_WATERFALL_ENRICHMENT_V2.md Part 1.4: ReverseContact and Datagma return
# structurally identical positionHistory / educationHistory shapes. One shared helper
# maps both; the provider clients do the provider-specific path extraction and hand the
# common sub-objects here.
#
# Part 5 rule 6 — GDPR exclusions: this helper extracts ONLY the canonical fields below.
# gender, birth dates, phone numbers, inferred salary and photo/logo URLs are never read,
# regardless of what the provider returned. strip_to_canonical() is the structural guard.


def _date_from_month_year(d: dict[str, Any] | None, *, day: int = 1, month_fallback: int = 1) -> date | None:
    """Build a date from a {"month": m, "year": y} or {"year": y} block.
    Used for position start dates (day=1)."""
    if not d:
        return None
    year = d.get("year")
    if not year:
        return None
    try:
        month = int(d.get("month") or month_fallback)
        return date(int(year), month, day)
    except (ValueError, TypeError):
        return None


def _education_end_date_from_block(block: dict[str, Any] | None) -> date | None:
    """Education end → Dec 31 of the end year (conservative — same rule as the PDL mapper)."""
    if not block:
        return None
    year = block.get("year")
    if not year:
        return None
    try:
        return date(int(year), 12, 31)
    except (ValueError, TypeError):
        return None


def _current_position(position_history: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The current position = the entry whose startEndDate.end is null; else the most recent."""
    if not position_history:
        return None
    for pos in position_history:
        if (pos.get("startEndDate") or {}).get("end") in (None, {}):
            return pos
    # No open-ended role: pick the one with the latest start year.
    def _start_year(p: dict[str, Any]) -> int:
        return ((p.get("startEndDate") or {}).get("start") or {}).get("year") or 0
    return sorted(position_history, key=_start_year, reverse=True)[0]


def _latest_education(education_history: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The education entry with the latest end year (else the first)."""
    if not education_history:
        return None
    def _end_year(e: dict[str, Any]) -> int:
        return ((e.get("startEndDate") or {}).get("end") or {}).get("year") or 0
    with_end = [e for e in education_history if ((e.get("startEndDate") or {}).get("end") or {}).get("year")]
    if with_end:
        return sorted(with_end, key=_end_year, reverse=True)[0]
    return education_history[0]


def _band_from_employee_count(count: int | None) -> str | None:
    """Map an integer employee count to a PDL-style size band."""
    if count is None:
        return None
    try:
        count = int(count)
    except (ValueError, TypeError):
        return None
    if count <= 10:
        return "1-10"
    if count <= 50:
        return "11-50"
    if count <= 200:
        return "51-200"
    if count <= 500:
        return "201-500"
    if count <= 1000:
        return "501-1000"
    if count <= 5000:
        return "1001-5000"
    if count <= 10000:
        return "5001-10000"
    return "10001+"


def _split_location(location: str | None) -> dict[str, Any]:
    """Deterministic parse of a 'City, Region, Country' free string → li_city/li_state/li_country.

    Providers that hand back a single location string (ReverseContact, Datagma, Hunter
    location) are parsed positionally. Kept pure (no Location Cleaner API call) so provider
    mapper tests run on fixtures with no live calls (Part 8.1). The subscriber's own
    account_location is already normalised by pre_enrichment via PDL Location Cleaner.
    """
    if not location or not isinstance(location, str):
        return {}
    parts = [p.strip() for p in location.split(",") if p.strip()]
    if not parts:
        return {}
    out: dict[str, Any] = {"li_country": parts[-1]}
    if len(parts) >= 2:
        out["li_city"] = parts[0]
    if len(parts) >= 3:
        out["li_state"] = parts[1]
    return out


def strip_to_canonical(fields: dict[str, Any]) -> dict[str, Any]:
    """GDPR structural guard (Part 5 rule 6): keep ONLY canonical enrichment fields,
    dropping any None values. Every provider mapper passes its output through this."""
    from services.enrichment.providers.base import CANONICAL_ENRICHMENT_FIELDS
    return {
        k: v for k, v in fields.items()
        if k in CANONICAL_ENRICHMENT_FIELDS and v is not None
    }


def _map_linkedin_style_profile(
    *,
    linkedin_url: str | None,
    job_title: str | None,
    position_history: list[dict[str, Any]] | None,
    education_history: list[dict[str, Any]] | None,
    company: dict[str, Any] | None,
    location: str | None,
) -> dict[str, Any]:
    """Shared mapper for ReverseContact / Datagma LinkedIn-style profiles → canonical fields.

    `company` is a normalised dict: {name, domain, industry, employee_count?, size?}.
    Returns canonical fields only (passed through strip_to_canonical).
    """
    position_history = position_history or []
    education_history = education_history or []
    company = company or {}

    current = _current_position(position_history) or {}
    cur_dates = current.get("startEndDate") or {}
    edu = _latest_education(education_history) or {}
    edu_dates = edu.get("startEndDate") or {}

    size = company.get("size") or _band_from_employee_count(company.get("employee_count"))

    fields: dict[str, Any] = {
        "linkedin_profile_url": linkedin_url,
        "li_job_title": current.get("title") or job_title,
        "li_current_employer_name": current.get("companyName") or company.get("name"),
        "li_current_employer_domain": company.get("domain"),
        "li_employer_industry": company.get("industry"),
        "li_employer_size": size,
        "li_job_start_date": _date_from_month_year(cur_dates.get("start")),
        "li_job_end_date": _date_from_month_year(cur_dates.get("end")),
        "li_education_institution": edu.get("schoolName"),
        "li_education_end_date": _education_end_date_from_block(edu_dates.get("end")),
    }
    fields.update(_split_location(location))
    return strip_to_canonical(fields)


def map_hunter_person(data: dict[str, Any]) -> dict[str, Any]:
    """Map a Hunter people/find response → canonical fields (Part 1.2).

    Hunter returns NO education and NO employment dates — always PARTIAL.
    """
    employment = data.get("employment") or {}
    linkedin = data.get("linkedin") or {}
    geo = data.get("geo") or {}

    handle = linkedin.get("handle")
    linkedin_url = f"https://linkedin.com/{handle}" if handle else None
    seniority = employment.get("seniority")

    fields: dict[str, Any] = {
        "li_current_employer_name": employment.get("name"),
        "li_current_employer_domain": employment.get("domain"),
        "li_job_title": employment.get("title"),
        "li_job_title_levels": [seniority] if seniority else None,
        "linkedin_profile_url": linkedin_url,
        "li_country": geo.get("country"),
    }
    return strip_to_canonical(fields)


def map_reversecontact_person(body: dict[str, Any]) -> dict[str, Any]:
    """Map a ReverseContact /enrichment response → canonical fields (Part 1.3)."""
    person = body.get("person") or {}
    company = body.get("company") or {}
    positions = (person.get("positions") or {}).get("positionHistory") or []
    schools = (person.get("schools") or {}).get("educationHistory") or []
    return _map_linkedin_style_profile(
        linkedin_url=person.get("linkedInUrl"),
        job_title=None,
        position_history=positions,
        education_history=schools,
        company={
            "name": company.get("name"),
            "domain": company.get("websiteUrl"),
            "industry": company.get("industry"),
            "employee_count": company.get("employeeCount"),
        },
        location=person.get("location"),
    )


def map_datagma_person(body: dict[str, Any]) -> dict[str, Any]:
    """Map a Datagma /full response → canonical fields (Part 1.4).
    Same positionHistory/educationHistory shape as ReverseContact; different root paths."""
    person = body.get("person") or {}
    basic = person.get("basic") or {}
    details = person.get("details") or {}
    positions = (details.get("positions") or {}).get("positionHistory") or []
    schools = (details.get("schools") or {}).get("educationHistory") or []
    company_basic = (body.get("company") or {}).get("basic") or {}
    return _map_linkedin_style_profile(
        linkedin_url=basic.get("linkedInUrl"),
        job_title=basic.get("title"),
        position_history=positions,
        education_history=schools,
        company={
            "name": company_basic.get("name"),
            "domain": company_basic.get("website"),
            "industry": company_basic.get("industry"),
            "size": company_basic.get("size"),
        },
        location=basic.get("location"),
    )


def map_fullenrich_contact(contact: dict[str, Any]) -> dict[str, Any]:
    """Map a FullEnrich webhook result `contact` block → canonical fields (Part 1.6).
    Education coverage is provider-dependent; map what arrives, gap the rest."""
    fields: dict[str, Any] = {
        "linkedin_profile_url": contact.get("linkedin_url"),
        "li_job_title": contact.get("job_title"),
        "li_current_employer_name": contact.get("company_name"),
        "li_current_employer_domain": contact.get("company_domain"),
    }
    fields.update(_split_location(contact.get("location")))
    return strip_to_canonical(fields)
