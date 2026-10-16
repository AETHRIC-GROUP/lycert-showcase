"""FullEnrich — waterfall Step 5 (async waterfall-of-waterfalls final sweep).

LYCERT_WATERFALL_ENRICHMENT_V2.md Part 1.6. One API that internally cascades 15+ providers
and charges 1 credit only on success. ASYNCHRONOUS: submit returns an enrichment_id; results
arrive via webhook (POST to our endpoint).

Endpoint paths confirmed against live docs.fullenrich.com (Part 9 forbids inventing them):
  - Submit (reverse email lookup, our input shape):
      POST https://app.fullenrich.com/api/v2/contact/reverse/email/bulk
      body: {"name","webhook_url","webhook_events":{"contact_finished":url},"data":[{email,custom}]}
      → 200 {"enrichment_id": "..."}
  - Poll:    GET  https://app.fullenrich.com/api/v2/contact/reverse/email/bulk/{enrichment_id}
  - Credits: GET  https://app.fullenrich.com/api/v2/account/credits
Auth: Authorization: Bearer {key}.

SIGNATURE VERIFICATION — the public docs do NOT publish the exact header/scheme. The V2 doc
states "SHA1-signed header against the API key". We implement HMAC-SHA1(raw_body, api_key) with
a configurable header name (LYCERT_FULLENRICH_SIGNATURE_HEADER). This MUST be reconciled with
FullEnrich's real scheme (dashboard/support) before production go-live — see DECISIONS.md.
"""

import hashlib
import hmac
import logging
import os
from dataclasses import dataclass
from typing import Any

import httpx

from services.enrichment.providers.base import (
    EnrichmentProvider,
    ProviderOutcome,
    ProviderResult,
)

logger = logging.getLogger(__name__)

_BASE = "https://app.fullenrich.com/api/v2"
_SUBMIT_URL = f"{_BASE}/contact/reverse/email/bulk"
_CREDITS_URL = f"{_BASE}/account/credits"
_TIMEOUT = 20.0
_COST_PER_SUCCESS = 0.050
_BULK_MAX = 100
_DEFAULT_SIGNATURE_HEADER = "X-FullEnrich-Signature"


def _api_key() -> str:
    key = os.environ.get("LYCERT_FULLENRICH_API_KEY", "")
    if not key:
        raise RuntimeError("LYCERT_FULLENRICH_API_KEY env var not set")
    return key


def signature_header_name() -> str:
    return os.environ.get("LYCERT_FULLENRICH_SIGNATURE_HEADER", _DEFAULT_SIGNATURE_HEADER)


def verify_signature(raw_body: bytes, provided_signature: str | None) -> bool:
    """Verify a webhook delivery: HMAC-SHA1(raw_body, api_key) == provided_signature (hex).

    Tolerates a 'sha1=' prefix. Constant-time comparison. Returns False on any mismatch,
    missing signature, or missing key.
    """
    if not provided_signature:
        return False
    try:
        key = _api_key().encode()
    except RuntimeError:
        return False
    expected = hmac.new(key, raw_body, hashlib.sha1).hexdigest()
    candidate = provided_signature.strip()
    if candidate.lower().startswith("sha1="):
        candidate = candidate[5:]
    return hmac.compare_digest(expected, candidate.lower())


@dataclass
class FullEnrichSubmitResult:
    enrichment_id: str | None
    submitted: int
    cost_estimate_usd: float = 0.0
    error_message: str | None = None


def _webhook_url() -> str:
    """Public URL FullEnrich POSTs results to. Configurable so staging/prod differ."""
    # Domain decision (DECISIONS.md 2026-06-05): lycert.com only — NOT lycert.ai (the V2 doc's
    # example used lycert.ai). The real per-environment URL must be set via the env var.
    return os.environ.get(
        "LYCERT_FULLENRICH_WEBHOOK_URL",
        "https://api.lycert.com/api/v1/enrichment/webhook/fullenrich",
    )


class FullEnrichClient(EnrichmentProvider):
    provider_key = "fullenrich"
    execution_mode = "async"

    def __init__(self, job_id: str | None = None) -> None:
        # Set by the orchestrator so the webhook can attribute credits to the job.
        self.job_id = job_id

    async def get_credit_balance(self) -> int | None:
        """Remaining credits, or None if unavailable. Checked before submitting batches."""
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                resp = await client.get(
                    _CREDITS_URL, headers={"Authorization": f"Bearer {_api_key()}"}
                )
            resp.raise_for_status()
            body = resp.json() or {}
            return body.get("credits") if isinstance(body.get("credits"), int) else body.get("remaining")
        except Exception:
            logger.exception("fullenrich credit balance check failed")
            return None

    async def submit_bulk(self, contacts: list[dict[str, str]]) -> FullEnrichSubmitResult:
        """Submit up to 100 contacts (reverse email lookup).
        Each contact: {"email": str, "subscriber_id": str}. job_id from self.job_id.
        """
        if not contacts:
            return FullEnrichSubmitResult(enrichment_id=None, submitted=0)
        if len(contacts) > _BULK_MAX:
            raise ValueError(f"FullEnrich bulk accepts max {_BULK_MAX} contacts per call")

        data = []
        for c in contacts:
            custom = {"lycert_subscriber_id": str(c["subscriber_id"])}
            if self.job_id:
                custom["lycert_job_id"] = str(self.job_id)
            data.append({"email": c["email"], "custom": custom})

        webhook_url = _webhook_url()
        body = {
            "name": f"lycert_batch_{self.job_id or 'adhoc'}",
            "webhook_url": webhook_url,
            "webhook_events": {"contact_finished": webhook_url},
            "data": data,
        }
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                resp = await client.post(
                    _SUBMIT_URL,
                    headers={"Authorization": f"Bearer {_api_key()}", "Content-Type": "application/json"},
                    json=body,
                )
            resp.raise_for_status()
            enrichment_id = (resp.json() or {}).get("enrichment_id")
            return FullEnrichSubmitResult(
                enrichment_id=enrichment_id,
                submitted=len(data),
                cost_estimate_usd=len(data) * _COST_PER_SUCCESS,
            )
        except Exception as exc:  # noqa: BLE001 — logged with traceback
            logger.exception("fullenrich submit_bulk failed count=%d", len(contacts))
            return FullEnrichSubmitResult(enrichment_id=None, submitted=0, error_message=str(exc))

    async def enrich(self, email: str, name: str | None, subscriber_id: str) -> ProviderResult:
        """Single-subscriber async handoff: submit one contact, return PENDING + enrichment_id.
        Results land later via the webhook receiver."""
        result = await self.submit_bulk([{"email": email, "subscriber_id": subscriber_id}])
        if not result.enrichment_id:
            return ProviderResult(
                self.provider_key, ProviderOutcome.ERROR, error_message=result.error_message
            )
        return ProviderResult(
            provider_key=self.provider_key,
            outcome=ProviderOutcome.PENDING,
            charged=False,                       # charged only on successful webhook result
            async_reference=result.enrichment_id,
        )


def parse_webhook_results(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract per-contact results from a FullEnrich webhook payload.

    Returns a list of {"subscriber_id", "job_id", "fields", "matched"} items.
    Education coverage is provider-dependent — map what arrives (Part 1.6).
    """
    from services.enrichment.field_mapper import map_fullenrich_contact

    items: list[dict[str, Any]] = []
    for item in (payload.get("data") or payload.get("datas") or []):
        custom = item.get("custom") or {}
        subscriber_id = custom.get("lycert_subscriber_id")
        if not subscriber_id:
            continue
        contact = item.get("contact") or {}
        fields = map_fullenrich_contact(contact) if contact else {}
        items.append({
            "subscriber_id": subscriber_id,
            "job_id": custom.get("lycert_job_id"),
            "fields": fields,
            "matched": bool(fields),
        })
    return items
