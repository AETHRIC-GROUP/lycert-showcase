"""Stripe service utilities for the FastAPI backend.

Handles enrichment usage reporting to Stripe metered billing.
Called by the enrichment service (Phase 2 Step 4) after each successful
enrichment to keep Stripe usage meters accurate.
"""

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)


def _stripe_client() -> Any:
    """Lazy import stripe so the API starts without LYCERT_STRIPE_SECRET_KEY set."""
    try:
        import stripe as stripe_lib
        key = os.getenv("LYCERT_STRIPE_SECRET_KEY")
        if not key:
            raise RuntimeError("LYCERT_STRIPE_SECRET_KEY not set")
        stripe_lib.api_key = key
        return stripe_lib
    except ImportError:
        raise RuntimeError("stripe package not installed — add to requirements.txt")


def create_stripe_customer(tenant_id: str, tenant_name: str, email: str) -> str:
    """Create a Stripe customer for a new tenant and return the customer ID.

    Called during onboarding (Phase 2 Step 3). The customer ID is stored in
    tenants.stripe_customer_id and used for all subsequent billing operations.
    """
    stripe = _stripe_client()
    customer = stripe.Customer.create(
        name=tenant_name,
        email=email,
        metadata={"lycert_tenant_id": tenant_id},
    )
    logger.info("stripe: created customer=%s tenant=%s", customer.id, tenant_id)
    return customer.id


def report_enrichment_usage(stripe_subscription_id: str, quantity: int = 1) -> None:
    """Report enrichment usage to Stripe for metered billing.

    Called after each successful enrichment (or in batch). Stripe accumulates
    these usage records and bills at the end of the billing period.

    Only reports when LYCERT_STRIPE_SECRET_KEY is set — safe to call in staging
    with test keys or in dev with no key (logs a warning instead of failing).
    """
    key = os.getenv("LYCERT_STRIPE_SECRET_KEY")
    if not key:
        logger.warning("stripe: LYCERT_STRIPE_SECRET_KEY not set — skipping usage report")
        return

    try:
        stripe = _stripe_client()
        # Retrieve subscription to get the metered item ID
        subscription = stripe.Subscription.retrieve(stripe_subscription_id)
        metered_items = [
            item for item in subscription["items"]["data"]
            if item["price"].get("recurring", {}).get("usage_type") == "metered"
        ]
        if not metered_items:
            logger.warning("stripe: no metered item on subscription=%s", stripe_subscription_id)
            return

        stripe.SubscriptionItem.create_usage_record(
            metered_items[0]["id"],
            quantity=quantity,
            action="increment",
        )
        logger.info(
            "stripe: reported %d enrichment(s) for subscription=%s",
            quantity, stripe_subscription_id,
        )
    except Exception:
        logger.exception(
            "stripe: failed to report enrichment usage subscription=%s quantity=%d",
            stripe_subscription_id, quantity,
        )
        raise
