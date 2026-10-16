"""Hunter Enrichment API — waterfall Step 1 (cheap first pass).

LYCERT_WATERFALL_ENRICHMENT_V2.md Part 1.2. Cheapest professional lookup; catches easy
hits for pennies. Returns NO education and NO employment dates → a Hunter hit is always
PARTIAL and never stops the waterfall.

Auth: api_key as a query parameter.
"""

import logging
import os

import httpx

from services.enrichment.field_mapper import map_hunter_person
from services.enrichment.providers.base import (
    EnrichmentProvider,
    ProviderOutcome,
    ProviderResult,
    classify_completeness,
)

logger = logging.getLogger(__name__)

_URL = "https://api.hunter.io/v2/people/find"
_TIMEOUT = 10.0
_COST_PER_MATCH = 0.004


class HunterClient(EnrichmentProvider):
    provider_key = "hunter"
    execution_mode = "sync"

    async def enrich(self, email: str, name: str | None, subscriber_id: str) -> ProviderResult:
        api_key = os.environ.get("LYCERT_HUNTER_API_KEY", "")
        if not api_key:
            return ProviderResult(self.provider_key, ProviderOutcome.MISS, charged=False)
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                resp = await client.get(_URL, params={"email": email, "api_key": api_key})
            if resp.status_code == 404:
                return ProviderResult(self.provider_key, ProviderOutcome.MISS, charged=False)
            resp.raise_for_status()
        except Exception as exc:  # noqa: BLE001 — logged with traceback
            logger.exception("HunterClient.enrich error sub=%s", subscriber_id)
            return ProviderResult(self.provider_key, ProviderOutcome.ERROR, error_message=str(exc))

        data = (resp.json() or {}).get("data") or {}
        if not data:
            return ProviderResult(self.provider_key, ProviderOutcome.MISS, charged=False)

        fields = map_hunter_person(data)
        outcome = classify_completeness(fields)
        if outcome == ProviderOutcome.MISS:
            return ProviderResult(self.provider_key, ProviderOutcome.MISS, charged=False)

        name_obj = data.get("name") or {}
        full_name = name_obj.get("fullName")
        return ProviderResult(
            provider_key=self.provider_key,
            outcome=outcome,          # PARTIAL — Hunter never satisfies education/dates
            fields=fields,
            charged=True,
            cost_usd=_COST_PER_MATCH,
            full_name=full_name,
        )
