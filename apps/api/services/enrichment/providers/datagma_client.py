"""Datagma — waterfall Step 3 (unique-find real-time provider).

LYCERT_WATERFALL_ENRICHMENT_V2.md Part 1.4. Real-time lookup against live web sources
(no static DB) — GDPR-positioned, high unique-find rate. Returns education + dates → can
produce a COMPLETE result.

Auth: apiId as a query parameter.
NEVER request phone data: phoneFull stays false (30x cost, GDPR-unnecessary — Part 9).
"""

import logging
import os

import httpx

from services.enrichment.field_mapper import map_datagma_person
from services.enrichment.providers.base import (
    EnrichmentProvider,
    ProviderOutcome,
    ProviderResult,
    classify_completeness,
)

logger = logging.getLogger(__name__)

_URL = "https://gateway.datagma.net/api/ingress/v2/full"
_TIMEOUT = 15.0
_COST_PER_MATCH = 0.030


class DatagmaClient(EnrichmentProvider):
    provider_key = "datagma"
    execution_mode = "sync"

    async def enrich(self, email: str, name: str | None, subscriber_id: str) -> ProviderResult:
        api_key = os.environ.get("LYCERT_DATAGMA_API_KEY", "")
        if not api_key:
            return ProviderResult(self.provider_key, ProviderOutcome.MISS, charged=False)
        params = {
            "apiId": api_key,
            "data": email,               # Datagma's input param (auto-detects email/LinkedIn/name); `email` 400s
            "personFull": "true",        # education + past experience → needed for a COMPLETE result
            "companyPremium": "false",  # no paid company data here
            "phoneFull": "false",        # NEVER true — 30x cost, GDPR-unnecessary
        }
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                resp = await client.get(_URL, params=params)
            # 404/422 = not found; 400 = Datagma declines the domain ("This email is not accepted" — it
            # rejects free/personal & some edu providers). All are clean MISSes (no charge), not errors.
            if resp.status_code in (400, 404, 422):
                return ProviderResult(self.provider_key, ProviderOutcome.MISS, charged=False)
            resp.raise_for_status()
            body = resp.json() or {}
        except Exception as exc:  # noqa: BLE001 — logged with traceback
            logger.exception("DatagmaClient.enrich error sub=%s", subscriber_id)
            return ProviderResult(self.provider_key, ProviderOutcome.ERROR, error_message=str(exc))

        fields = map_datagma_person(body)
        outcome = classify_completeness(fields)
        if outcome == ProviderOutcome.MISS:
            return ProviderResult(self.provider_key, ProviderOutcome.MISS, charged=False)

        basic = (body.get("person") or {}).get("basic") or {}
        return ProviderResult(
            provider_key=self.provider_key,
            outcome=outcome,
            fields=fields,
            charged=True,
            cost_usd=_COST_PER_MATCH,
            full_name=basic.get("fullName"),
        )
