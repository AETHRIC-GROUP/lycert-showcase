"""ReverseContact — waterfall Step 2 (personal-email specialist).

LYCERT_WATERFALL_ENRICHMENT_V2.md Part 1.3. The personal-email → LinkedIn-profile
specialist that caught what PDL missed in the design-partner sample. Returns full profile INCLUDING
education history → can produce a COMPLETE result and stop the waterfall.

Auth: api_key as a query parameter.
Rate limit: 15 requests/second — enforced by a process-wide async token bucket.

Credit note (Part 1.3): reviews report credits sometimes consumed on no-match. We therefore
mark every answered call as charged so cost tracking is conservative; reconcile monthly
against /v2/usage.
"""

import asyncio
import logging
import os
import time

import httpx

from services.enrichment.field_mapper import map_reversecontact_person
from services.enrichment.providers.base import (
    EnrichmentProvider,
    ProviderOutcome,
    ProviderResult,
    classify_completeness,
)

logger = logging.getLogger(__name__)

_URL = "https://api.reversecontact.com/enrichment"
_TIMEOUT = 15.0
_COST_PER_LOOKUP = 0.030
_MAX_RPS = 15


class _TokenBucket:
    """Minimal process-wide rate limiter: at most `rps` acquisitions per rolling second."""

    def __init__(self, rps: int) -> None:
        self._min_interval = 1.0 / rps
        self._lock = asyncio.Lock()
        self._next_allowed = 0.0

    async def acquire(self) -> None:
        async with self._lock:
            now = time.monotonic()
            wait = self._next_allowed - now
            if wait > 0:
                await asyncio.sleep(wait)
                now = time.monotonic()
            self._next_allowed = now + self._min_interval


_bucket = _TokenBucket(_MAX_RPS)


class ReverseContactClient(EnrichmentProvider):
    provider_key = "reversecontact"
    execution_mode = "sync"

    async def enrich(self, email: str, name: str | None, subscriber_id: str) -> ProviderResult:
        api_key = os.environ.get("LYCERT_REVERSECONTACT_API_KEY", "")
        if not api_key:
            return ProviderResult(self.provider_key, ProviderOutcome.MISS, charged=False)

        await _bucket.acquire()
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                resp = await client.get(_URL, params={"apikey": api_key, "mail": email})
            resp.raise_for_status()
            body = resp.json() or {}
        except Exception as exc:  # noqa: BLE001 — logged with traceback
            logger.exception("ReverseContactClient.enrich error sub=%s", subscriber_id)
            return ProviderResult(self.provider_key, ProviderOutcome.ERROR, error_message=str(exc))

        if not body.get("success"):
            # No match — but credits may still have been consumed; count it.
            return ProviderResult(
                self.provider_key, ProviderOutcome.MISS, charged=True, cost_usd=_COST_PER_LOOKUP
            )

        fields = map_reversecontact_person(body)
        person = body.get("person") or {}
        full_name = " ".join(p for p in (person.get("firstName"), person.get("lastName")) if p) or None
        outcome = classify_completeness(fields)
        return ProviderResult(
            provider_key=self.provider_key,
            outcome=outcome,
            fields=fields,
            charged=True,
            cost_usd=_COST_PER_LOOKUP,
            full_name=full_name,
        )
