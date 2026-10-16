"""Enrichment priority queue.

Computes a 0–100 priority score for each subscriber after pre-enrichment.
Higher score = enrich sooner. Used to sort the enrichment queue.

The compute_enrichment_priority function is the exact spec from
LYCERT_ENRICHMENT_ARCHITECTURE.md Part 3.2.
"""

from datetime import date
from typing import Any


def compute_enrichment_priority(subscriber: dict[str, Any], today: date | None = None) -> int:
    """Return priority score 0–100. Higher = enrich sooner.
    Called after pre-enrichment completes. Stored in subscribers.enrichment_priority.

    Spec: LYCERT_ENRICHMENT_ARCHITECTURE.md Part 3.2.
    """
    if today is None:
        today = date.today()

    score = 0

    # Graduation timing (most important factor)
    grad_date_raw = subscriber.get("stated_graduation_date")
    if grad_date_raw:
        try:
            if isinstance(grad_date_raw, str):
                grad_date = date.fromisoformat(grad_date_raw[:10])
            else:
                grad_date = grad_date_raw
            days_since_grad = (today - grad_date).days
            if days_since_grad > 365:
                score += 40
            elif days_since_grad > 180:
                score += 30
            elif days_since_grad > 0:
                score += 20
            elif days_since_grad > -90:   # graduating within 90 days
                score += 15
            # else: graduation > 90 days away → 0 pts
        except (ValueError, TypeError):
            pass

    # Email domain type (strong signal)
    domain_type = subscriber.get("email_domain_type")
    if domain_type == "corporate":
        score += 25
    elif domain_type == "personal":
        score += 10
    elif domain_type == "disposable":
        score += 20
    # academic → 0 pts (expected for edu subscribers)

    # Institution trust
    trust_tier = subscriber.get("institution_trust_tier")
    pdl_verified = subscriber.get("institution_pdl_verified", True)
    if trust_tier == "suspicious":
        score += 20
    elif not pdl_verified:
        score += 10
    elif trust_tier == "low":
        score += 5

    # Auto-renew signal
    if subscriber.get("auto_renew"):
        score += 5

    return min(score, 100)
