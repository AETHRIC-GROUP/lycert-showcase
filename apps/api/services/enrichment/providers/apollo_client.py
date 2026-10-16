"""Apollo enrichment client — fallback when PDL returns 404.

Apollo does NOT return education history.
C3 signal will be data_gap for Apollo-only matches.

API docs: https://docs.apollo.io/reference/people-enrichment

Note: Apollo API key = LYCERT_APOLLO_API_KEY env var (platform-managed).
If not set, Apollo fallback is silently skipped (not an error).
"""

import logging
import os
from typing import Any

import httpx
from supabase import Client

from services.enrichment.providers.base import (
    EnrichmentProvider,
    ProviderOutcome,
    ProviderResult,
    classify_completeness,
)

logger = logging.getLogger(__name__)

# Correct base: /api/v1 not /v1
_APOLLO_BASE = "https://api.apollo.io/api/v1"
_TIMEOUT = 10.0


async def enrich_person_apollo(
    subscriber_id: str,
    tenant_id: str,
    db: Client,
) -> dict[str, Any] | None:
    """Attempt Apollo enrichment for a subscriber.

    Reads subscriber email/name from DB, calls Apollo, returns mapped fields.
    Returns None if Apollo key is not set, subscriber not found, or Apollo misses.
    """
    api_key = os.environ.get("LYCERT_APOLLO_API_KEY", "")
    if not api_key:
        return None

    try:
        sub = (
            db.table("subscribers")
            .select("email, name")
            .eq("id", subscriber_id)
            .eq("tenant_id", tenant_id)
            .maybe_single()
            .execute()
        ).data
        if not sub:
            return None

        # Auth: Bearer token in header (not api_key in body)
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.post(
                f"{_APOLLO_BASE}/people/match",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                    "Cache-Control": "no-cache",
                },
                json={"email": sub["email"], "name": sub.get("name")},
            )
        if resp.status_code in (404, 422, 429):
            return None
        resp.raise_for_status()
        data = resp.json()
        person = data.get("person") or {}
        if not person:
            return None

        org = person.get("organization") or {}
        emp_hist = person.get("employment_history") or []
        current = next((e for e in emp_hist if e.get("current")), emp_hist[0] if emp_hist else {})

        # seniority → li_job_title_levels (Apollo uses e.g. "senior", "manager")
        seniority = person.get("seniority")

        return {
            "linkedin_profile_url": person.get("linkedin_url"),
            "li_current_employer_name": org.get("name"),
            "li_current_employer_domain": org.get("website_url"),
            "li_current_employer_linkedin_url": org.get("linkedin_url"),
            "li_employer_size": _map_employee_count(org.get("estimated_num_employees")),
            "li_employer_industry": org.get("industry"),
            "li_job_start_date": _parse_date(current.get("start_date")),
            "li_job_end_date": _parse_date(current.get("end_date")),
            "li_job_title": person.get("title"),
            "li_job_title_levels": [seniority] if seniority else None,
            # Apollo does not return education history — leave null
            "li_education_institution": None,
            "li_education_end_date": None,
            "li_country": person.get("country"),
            "li_state": person.get("state"),
            "li_city": person.get("city"),
        }
    except Exception:
        logger.exception("apollo_enrich failed subscriber=%s", subscriber_id)
        return None


def _parse_date(date_str: str | None):
    from services.enrichment.field_mapper import _parse_pdl_date
    return _parse_pdl_date(date_str)


def _map_employee_count(count: int | None) -> str | None:
    """Map Apollo's estimated_num_employees integer to PDL-style size band."""
    if count is None:
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


# ── Waterfall adapter (V2) ────────────────────────────────────────────────────
# Apollo is REMOVED from the default waterfall (Part 1.7): People Enrichment requires a
# paid plan and returns no education. The class is kept and registered DISABLED so it can
# be re-enabled as an enterprise add-on without code changes.

class ApolloProvider(EnrichmentProvider):
    provider_key = "apollo"
    execution_mode = "sync"

    async def enrich(self, email: str, name: str | None, subscriber_id: str) -> ProviderResult:
        api_key = os.environ.get("LYCERT_APOLLO_API_KEY", "")
        if not api_key:
            return ProviderResult(self.provider_key, ProviderOutcome.MISS, charged=False)
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                resp = await client.post(
                    f"{_APOLLO_BASE}/people/match",
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                        "Cache-Control": "no-cache",
                    },
                    json={"email": email, "name": name},
                )
            if resp.status_code in (404, 422, 429):
                return ProviderResult(self.provider_key, ProviderOutcome.MISS, charged=False)
            resp.raise_for_status()
            person = (resp.json() or {}).get("person") or {}
            if not person:
                return ProviderResult(self.provider_key, ProviderOutcome.MISS, charged=False)

            org = person.get("organization") or {}
            emp_hist = person.get("employment_history") or []
            current = next((e for e in emp_hist if e.get("current")), emp_hist[0] if emp_hist else {})
            seniority = person.get("seniority")
            fields = {
                "linkedin_profile_url": person.get("linkedin_url"),
                "li_current_employer_name": org.get("name"),
                "li_current_employer_domain": org.get("website_url"),
                "li_current_employer_linkedin_url": org.get("linkedin_url"),
                "li_employer_size": _map_employee_count(org.get("estimated_num_employees")),
                "li_employer_industry": org.get("industry"),
                "li_job_start_date": _parse_date(current.get("start_date")),
                "li_job_end_date": _parse_date(current.get("end_date")),
                "li_job_title": person.get("title"),
                "li_job_title_levels": [seniority] if seniority else None,
                "li_country": person.get("country"),
                "li_state": person.get("state"),
                "li_city": person.get("city"),
            }
            return ProviderResult(
                provider_key=self.provider_key,
                outcome=classify_completeness(fields),
                fields=fields,
                charged=True,
                cost_usd=0.0,
                full_name=person.get("name"),
            )
        except Exception as exc:  # noqa: BLE001 — logged with traceback
            logger.exception("ApolloProvider.enrich failed sub=%s", subscriber_id)
            return ProviderResult(self.provider_key, ProviderOutcome.ERROR, error_message=str(exc))
