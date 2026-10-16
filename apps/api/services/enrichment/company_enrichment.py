"""Secondary company enrichment (Endpoint H).

Trigger conditions (ALL three must be true — spec 1.9):
  1. Person Enrichment returned likelihood >= 6
  2. li_current_employer_domain is populated and is NOT an academic domain
  3. Subscriber is in lifecycle_stage = 'approaching_graduation' OR
     'post_graduation_unverified' OR scored Tier 1/2

Writes to subscriber_employer_enrichment table.
Used by the Graduation Transition Engine for offer personalisation.
"""

import logging
import os
from datetime import datetime, timezone, timedelta
from typing import Any

from supabase import Client

from services.enrichment.providers.pdl_client import enrich_company

logger = logging.getLogger(__name__)

_RETENTION_DAYS = 30

# Domains that indicate the employer is an academic institution — skip company enrichment
_ACADEMIC_EMPLOYER_TLDS = (
    ".edu", ".ac.uk", ".ac.jp", ".edu.au", ".edu.br",
)

_QUALIFYING_STAGES = {"approaching_graduation", "post_graduation_unverified"}


def _is_academic_domain(domain: str | None) -> bool:
    if not domain:
        return False
    d = domain.lower().strip()
    return any(d.endswith(tld) for tld in _ACADEMIC_EMPLOYER_TLDS)


def _qualifies_for_company_enrichment(
    subscriber: dict[str, Any],
    likelihood: int,
    enrichment_record: dict[str, Any],
) -> bool:
    """Return True when all three conditions from spec 1.9 are met."""
    # Condition 1: likelihood >= 6
    if likelihood < 6:
        return False
    # Condition 2: employer domain populated and not academic
    domain = enrichment_record.get("li_current_employer_domain")
    if not domain or _is_academic_domain(domain):
        return False
    # Condition 3: lifecycle stage or tier
    stage = subscriber.get("lifecycle_stage", "")
    if stage in _QUALIFYING_STAGES:
        return True
    # Tier 1/2 check from latest score
    latest_tier = subscriber.get("_latest_confidence_tier")  # injected by orchestrator
    if latest_tier in (1, 2):
        return True
    # AEC Professional Confirmed
    if subscriber.get("_aec_professional_confirmed"):
        return True
    return False


async def run_company_enrichment(
    db: Client,
    subscriber_id: str,
    tenant_id: str,
    subscriber: dict[str, Any],
    likelihood: int,
    enrichment_record: dict[str, Any],
) -> bool:
    """Attempt company enrichment if conditions are met. Returns True if data was written."""
    if not _qualifies_for_company_enrichment(subscriber, likelihood, enrichment_record):
        return False

    domain = enrichment_record.get("li_current_employer_domain")
    try:
        company_data = await enrich_company(domain)
    except Exception:
        logger.exception("company_enrichment API error domain=%s sub=%s", domain, subscriber_id)
        return False

    if not company_data:
        return False

    now = datetime.now(timezone.utc)
    try:
        db.table("subscriber_employer_enrichment").upsert(
            {
                "subscriber_id": subscriber_id,
                "tenant_id": tenant_id,
                "employer_name_canonical": company_data.get("name"),
                "employer_size_band": company_data.get("size"),
                "employer_headcount": company_data.get("employee_count"),
                "employer_industry": company_data.get("industry"),
                "employer_founded_year": company_data.get("founded"),
                "employer_total_funding": company_data.get("total_funding_raised"),
                "employer_pdl_id": company_data.get("id"),
                "enriched_at": now.isoformat(),
                "delete_at": (now + timedelta(days=_RETENTION_DAYS)).isoformat(),
            },
            on_conflict="subscriber_id",
        ).execute()
        logger.info("company_enrichment written sub=%s domain=%s", subscriber_id, domain)
        return True
    except Exception:
        logger.exception("company_enrichment DB write failed sub=%s", subscriber_id)
        return False
