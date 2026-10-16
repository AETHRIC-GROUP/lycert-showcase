"""PDL API client.

Endpoints used by Lycert (all verified against docs.peopledatalabs.com):

  A. GET  /v5/person/enrich    — single person enrichment ($0.28/200 response)
  B. POST /v5/person/bulk      — batch up to 100 in one request (1 rate-limit hit)
  C. GET  /v5/person/identify  — fuzzy fallback when email 404s (paid, tertiary)
  E. GET  /v5/school/clean     — normalise institution name (free)
  F. GET  /v5/location/clean   — normalise location string (free)
  G. GET  /v5/job_title/enrich — normalise job title for email personalisation (free)
  H. GET  /v5/company/enrich   — employer intelligence (paid, secondary)

Key facts from official docs:
  - Auth header: X-Api-Key (never put key in query string — appears in logs)
  - min_likelihood: PDL returns 404 (free) instead of low-quality 200 (charged)
  - required="experience AND education": PDL returns 404 (free) if profile has neither
  - 200 responses = charged; 404 = free
  - location_locality = city (NOT location_city — official schema field name)
  - company enrichment response fields are at root level (not nested in data{})
"""

import logging
import os
from dataclasses import dataclass, field
from typing import Any

import httpx

from services.enrichment.providers.base import (
    EnrichmentProvider,
    ProviderOutcome,
    ProviderResult,
    classify_completeness,
)

logger = logging.getLogger(__name__)

_PDL_COST_PER_MATCH = 0.28

_BASE = "https://api.peopledatalabs.com/v5"
_TIMEOUT_SINGLE = 10.0
_TIMEOUT_BULK = 30.0
_TIMEOUT_FREE = 5.0
_MIN_LIKELIHOOD = 4


def _headers() -> dict[str, str]:
    key = os.environ.get("LYCERT_PDL_API_KEY", "")
    if not key:
        raise RuntimeError("LYCERT_PDL_API_KEY env var not set")
    return {"X-Api-Key": key, "Content-Type": "application/json"}


@dataclass
class PDLPersonResult:
    status: int                         # 200 = hit, 404 = miss
    charged: bool = False               # true only on 200
    likelihood: int = 0
    data: dict[str, Any] = field(default_factory=dict)
    subscriber_id: str | None = None    # set for bulk results


@dataclass
class PDLCompanyResult:
    status: int
    data: dict[str, Any] = field(default_factory=dict)


class PDLAPIError(Exception):
    def __init__(self, status_code: int, message: str) -> None:
        self.status_code = status_code
        super().__init__(f"PDL API error {status_code}: {message}")


# ── Endpoint A: Single Person Enrichment ──────────────────────────────────────

async def enrich_person(
    email: str,
    name: str | None = None,
    min_likelihood: int = _MIN_LIKELIHOOD,
) -> PDLPersonResult:
    """Single person enrichment. Use only for manual/on-demand triggers.
    For batch operations always use enrich_person_bulk() — it costs the same
    but counts as one rate-limit hit.
    """
    params: dict[str, Any] = {
        "email": email,
        "min_likelihood": min_likelihood,
        "required": "experience AND education",
        "pretty": "false",
    }
    if name:
        params["name"] = name

    async with httpx.AsyncClient(timeout=_TIMEOUT_SINGLE) as client:
        resp = await client.get(f"{_BASE}/person/enrich", headers=_headers(), params=params)

    if resp.status_code == 200:
        body = resp.json()
        return PDLPersonResult(
            status=200,
            charged=True,
            likelihood=body["likelihood"],
            data=body["data"],
        )
    if resp.status_code == 404:
        return PDLPersonResult(status=404, charged=False)

    # 400 / 401 / 402 / 429 / 500
    try:
        msg = resp.json().get("error", {}).get("message", "unknown")
    except Exception:
        msg = resp.text[:200]
    raise PDLAPIError(resp.status_code, msg)


# ── Endpoint B: Bulk Person Enrichment ────────────────────────────────────────

async def enrich_person_bulk(
    requests: list[dict[str, Any]],
    min_likelihood: int = _MIN_LIKELIHOOD,
) -> list[PDLPersonResult]:
    """Enrich up to 100 subscribers in one HTTP call.
    Each item in requests: {"subscriber_id": str, "email": str, "name": str|None}
    Returns results in the same order as input.
    """
    if not requests:
        return []
    if len(requests) > 100:
        raise ValueError("PDL bulk endpoint accepts max 100 requests per call")

    bulk_body = {"requests": []}
    for req in requests:
        params: dict[str, Any] = {
            "email": req["email"],
            "min_likelihood": min_likelihood,
            "required": "experience AND education",
        }
        if req.get("name"):
            params["name"] = req["name"]
        bulk_body["requests"].append({
            "metadata": {"lycert_subscriber_id": str(req["subscriber_id"])},
            "params": params,
        })

    async with httpx.AsyncClient(timeout=_TIMEOUT_BULK) as client:
        resp = await client.post(
            f"{_BASE}/person/bulk",
            headers=_headers(),
            json=bulk_body,
        )

    if resp.status_code not in (200, 207):
        try:
            msg = resp.json().get("error", {}).get("message", "unknown")
        except Exception:
            msg = resp.text[:200]
        raise PDLAPIError(resp.status_code, msg)

    results: list[PDLPersonResult] = []
    for item in resp.json():
        sub_id = item.get("metadata", {}).get("lycert_subscriber_id")
        if item.get("status") == 200:
            results.append(PDLPersonResult(
                status=200,
                charged=True,
                likelihood=item["likelihood"],
                data=item["data"],
                subscriber_id=sub_id,
            ))
        else:
            results.append(PDLPersonResult(status=404, charged=False, subscriber_id=sub_id))

    return results


# ── Endpoint C: Person Identify (paid — tertiary fallback) ───────────────────

async def identify_person(
    name: str,
    institution_name: str | None = None,
    location: str | None = None,
    min_likelihood: int = 6,
) -> PDLPersonResult:
    """Fuzzy lookup when email enrichment returns 404.
    Only use for Tier 1 candidates when both PDL and Apollo miss.
    min_likelihood=6 (higher threshold for fuzzy match — spec 1.4).
    Returns top result only if likelihood >= min_likelihood, else 404.
    """
    params: dict[str, Any] = {
        "name": name,
        "min_likelihood": min_likelihood,
        "pretty": "false",
    }
    if institution_name:
        params["company"] = institution_name  # spec: use institution_name as 'company'
    if location:
        params["location"] = location

    async with httpx.AsyncClient(timeout=_TIMEOUT_SINGLE) as client:
        resp = await client.get(
            f"{_BASE}/person/identify",
            headers=_headers(),
            params=params,
        )

    if resp.status_code == 200:
        body = resp.json()
        matches = body.get("matches") or []
        if matches and matches[0].get("likelihood", 0) >= min_likelihood:
            top = matches[0]
            return PDLPersonResult(
                status=200,
                charged=True,
                likelihood=top["likelihood"],
                data=top.get("data", {}),
            )
        return PDLPersonResult(status=404, charged=False)
    if resp.status_code == 404:
        return PDLPersonResult(status=404, charged=False)

    try:
        msg = resp.json().get("error", {}).get("message", "unknown")
    except Exception:
        msg = resp.text[:200]
    raise PDLAPIError(resp.status_code, msg)


# ── Endpoint E: School Cleaner (free) ─────────────────────────────────────────

async def clean_school(institution_name: str) -> dict[str, Any] | None:
    """Normalise institution name. Returns None if PDL doesn't recognise it.
    Never charged. Run at import time.

    Response shape (verified from official schema):
      {name, type, id, location: {name, locality, region, country, continent},
       linkedin_url, facebook_url, twitter_url, linkedin_id, website, domain}
    """
    async with httpx.AsyncClient(timeout=_TIMEOUT_FREE) as client:
        resp = await client.get(
            f"{_BASE}/school/clean",
            headers=_headers(),
            params={"name": institution_name, "pretty": "false"},
        )
    if resp.status_code == 200:
        return resp.json().get("data") or resp.json()
    return None


# ── Endpoint F: Location Cleaner (free) ───────────────────────────────────────

async def clean_location(location_string: str) -> dict[str, Any] | None:
    """Normalise location string. Returns None if not parseable.
    Never charged. Run at import time.

    Response shape (verified):
      {name, locality, region, subregion, country, continent, type, geo}
    """
    async with httpx.AsyncClient(timeout=_TIMEOUT_FREE) as client:
        resp = await client.get(
            f"{_BASE}/location/clean",
            headers=_headers(),
            params={"location": location_string, "pretty": "false"},
        )
    if resp.status_code == 200:
        return resp.json().get("data") or resp.json()
    return None


# ── Endpoint G: Job Title Enrichment (free — email personalisation) ───────────

async def enrich_job_title(job_title: str) -> dict[str, Any] | None:
    """Normalise a raw job title string.
    Returns canonical title + similar titles + related skills, or None on miss.
    Never charged. Used by the Graduation Transition Engine email personalisation (Part 1.8).
    NOT used in scoring — scoring uses job_title_levels from Person Enrichment.
    """
    async with httpx.AsyncClient(timeout=_TIMEOUT_FREE) as client:
        resp = await client.get(
            f"{_BASE}/job_title/enrich",
            headers=_headers(),
            params={"job_title": job_title, "pretty": "false"},
        )
    if resp.status_code == 200:
        return resp.json().get("data") or resp.json()
    return None


# ── Endpoint H: Company Enrichment (paid, secondary) ──────────────────────────

async def enrich_company(domain: str) -> dict[str, Any] | None:
    """Employer intelligence from domain. Only for Tier 1/2 or AEC Pro confirmed.

    Company response fields are at ROOT of response (not nested in data{}).
    Verified from official docs: {status, likelihood, name, id, ...company fields}
    """
    async with httpx.AsyncClient(timeout=_TIMEOUT_SINGLE) as client:
        resp = await client.get(
            f"{_BASE}/company/enrich",
            headers=_headers(),
            params={"website": domain, "pretty": "false"},
        )
    if resp.status_code == 200:
        body = resp.json()
        # Company data is at root, not inside body["data"]
        body.pop("status", None)
        return body
    return None


# ── Waterfall adapter (V2) ────────────────────────────────────────────────────
# Wraps the existing enrich_person() + map_pdl_person() in the EnrichmentProvider
# interface so PDL can sit at position 4 of the registry-driven cascade.
# HTTP / 404-gating / mapping logic is UNCHANGED — only the class wrapper is new.

class PDLProvider(EnrichmentProvider):
    provider_key = "pdl"
    execution_mode = "sync"

    async def enrich(self, email: str, name: str | None, subscriber_id: str) -> ProviderResult:
        from services.enrichment.field_mapper import map_pdl_person
        from services.enrichment.providers.base import CANONICAL_ENRICHMENT_FIELDS

        try:
            result = await enrich_person(email, name=name)
        except PDLAPIError as exc:
            return ProviderResult(self.provider_key, ProviderOutcome.ERROR, error_message=str(exc))
        except Exception as exc:  # noqa: BLE001 — logged with traceback
            logger.exception("PDLProvider.enrich error sub=%s", subscriber_id)
            return ProviderResult(self.provider_key, ProviderOutcome.ERROR, error_message=str(exc))

        if result.status != 200:
            return ProviderResult(self.provider_key, ProviderOutcome.MISS, charged=False)

        mapped = map_pdl_person(result.data, result.likelihood, subscriber_id, "")
        fields = {k: v for k, v in mapped.items() if k in CANONICAL_ENRICHMENT_FIELDS}
        full_name = result.data.get("full_name") or result.data.get("name")
        return ProviderResult(
            provider_key=self.provider_key,
            outcome=classify_completeness(fields),
            fields=fields,
            charged=True,
            cost_usd=_PDL_COST_PER_MATCH,
            full_name=full_name,
        )
