"""FullEnrich async webhook processing + stale-pending cleanup.

LYCERT_WATERFALL_ENRICHMENT_V2.md Part 4.3. Kept separate from the route so it is unit-testable
with fixtures. The route (routers/enrich.py) verifies the SHA1 signature, then hands the parsed
payload here for background processing.

Idempotency (Part 4.3): dedupe on (enrichment_id, subscriber_id) via an audit_logs marker, so
FullEnrich's retries (every minute, up to 5×) never double-write enrichment or double-count
credits. Merge fills gaps only (FullEnrich is the last waterfall step — Part 5 rule 1).
"""

import logging
import os
from datetime import datetime, timezone, timedelta
from typing import Any

from supabase import create_client, Client

from services.enrichment.merge import merge_fields
from services.enrichment.providers.base import (
    CANONICAL_ENRICHMENT_FIELDS,
    ProviderOutcome,
    ProviderResult,
    classify_completeness,
)
from services.enrichment.providers.fullenrich_client import parse_webhook_results

logger = logging.getLogger(__name__)

_RETENTION_DAYS = 30
_PROCESSED_ACTION = "enrichment.fullenrich_processed"


def _db() -> Client:
    return create_client(
        os.environ["LYCERT_SUPABASE_URL"],
        os.environ["LYCERT_SUPABASE_SERVICE_ROLE_KEY"],
    )


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _already_processed(db: Client, enrichment_id: str | None, subscriber_id: str) -> bool:
    """True if we already processed this (enrichment_id, subscriber_id) delivery."""
    try:
        resp = (
            db.table("audit_logs")
            .select("id")
            .eq("action", _PROCESSED_ACTION)
            .eq("resource_id", subscriber_id)
            .eq("metadata->>enrichment_id", enrichment_id or "")
            .limit(1)
            .execute()
        )
        return bool(resp.data)
    except Exception:
        logger.exception("idempotency check failed eid=%s sub=%s", enrichment_id, subscriber_id)
        return False  # fail open → process; merge is gap-fill so a rare double is harmless


def _mark_processed(db: Client, tenant_id: str, enrichment_id: str | None, subscriber_id: str) -> None:
    try:
        db.table("audit_logs").insert({
            "tenant_id": tenant_id,
            "actor_type": "system",
            "actor_id": None,
            "action": _PROCESSED_ACTION,
            "resource_type": "subscriber",
            "resource_id": subscriber_id,
            "metadata": {"enrichment_id": enrichment_id, "provider": "fullenrich"},
        }).execute()
    except Exception:
        logger.exception("_mark_processed failed eid=%s sub=%s", enrichment_id, subscriber_id)


def _trigger_scoring(db: Client, tenant_id: str, subscriber_id: str) -> None:
    try:
        db.table("audit_logs").insert({
            "tenant_id": tenant_id,
            "actor_type": "system",
            "actor_id": None,
            "action": "subscriber.scoring_queued",
            "resource_type": "subscriber",
            "resource_id": subscriber_id,
            "metadata": {"trigger": "fullenrich_webhook"},
        }).execute()
    except Exception:
        logger.exception("_trigger_scoring failed sub=%s", subscriber_id)


def process_results(payload: dict[str, Any], enrichment_id: str | None = None) -> dict[str, Any]:
    """Process a FullEnrich webhook payload. Idempotent. Returns a summary dict."""
    db = _db()
    eid = enrichment_id or payload.get("id") or payload.get("enrichment_id")
    items = parse_webhook_results(payload)

    processed = skipped = matched = 0
    for item in items:
        sid = item["subscriber_id"]
        if _already_processed(db, eid, sid):
            skipped += 1
            continue

        row = (
            db.table("subscriber_enrichment").select("*")
            .eq("subscriber_id", sid).maybe_single().execute()
        ).data
        if not row:
            # No row to update (shouldn't happen — pending marker was written at handoff). Skip.
            logger.warning("fullenrich webhook: no enrichment row sub=%s", sid)
            continue
        tenant_id = row["tenant_id"]

        sub = (
            db.table("subscribers").select("name").eq("id", sid).maybe_single().execute()
        ).data or {}
        sub_name = sub.get("name")

        merged = {k: row.get(k) for k in CANONICAL_ENRICHMENT_FIELDS if row.get(k) is not None}
        provenance: dict[str, Any] = dict(row.get("field_provenance") or {})
        attempted: list[dict[str, Any]] = list(row.get("providers_attempted") or [])

        fe_fields = item["fields"]
        wrote_new = False
        if item["matched"] and fe_fields:
            synth = ProviderResult(
                provider_key="fullenrich",
                outcome=classify_completeness(fe_fields),
                fields=fe_fields,
                full_name=None,
            )
            before = len(merged)
            status = merge_fields(merged, provenance, synth, sub_name)
            wrote_new = status == "merged" and len(merged) > before
            fe_outcome = "complete" if classify_completeness(merged) == ProviderOutcome.COMPLETE else "partial"
        else:
            fe_outcome = "miss"

        # Replace the prior 'pending' fullenrich attempt entry with the resolved outcome.
        attempted = [a for a in attempted if a.get("provider") != "fullenrich"]
        attempted.append({"provider": "fullenrich", "outcome": fe_outcome})

        update: dict[str, Any] = {
            "field_provenance": provenance,
            "providers_attempted": attempted,
            "completeness": classify_completeness(merged).value,
            "pending_async_provider": None,
        }
        update.update({k: v for k, v in merged.items() if k in CANONICAL_ENRICHMENT_FIELDS})
        try:
            db.table("subscriber_enrichment").update(update).eq("subscriber_id", sid).execute()
        except Exception:
            logger.exception("fullenrich webhook update failed sub=%s", sid)
            continue

        _mark_processed(db, tenant_id, eid, sid)
        if wrote_new:
            _trigger_scoring(db, tenant_id, sid)
            matched += 1
        processed += 1

    return {"enrichment_id": eid, "processed": processed, "skipped": skipped, "matched": matched}


def cleanup_stale_pending(older_than_hours: int = 24) -> dict[str, Any]:
    """Nightly timeout job (Part 4.3): clear pending_async_provider older than `older_than_hours`,
    marking the FullEnrich outcome 'miss'. Returns count cleared."""
    db = _db()
    cutoff = (_now() - timedelta(hours=older_than_hours)).isoformat()
    rows = (
        db.table("subscriber_enrichment")
        .select("subscriber_id, providers_attempted, enriched_at")
        .not_.is_("pending_async_provider", "null")
        .lt("enriched_at", cutoff)
        .execute()
    ).data or []

    cleared = 0
    for row in rows:
        attempted = [a for a in (row.get("providers_attempted") or []) if a.get("provider") != "fullenrich"]
        attempted.append({"provider": "fullenrich", "outcome": "miss"})
        try:
            db.table("subscriber_enrichment").update({
                "pending_async_provider": None,
                "providers_attempted": attempted,
            }).eq("subscriber_id", row["subscriber_id"]).execute()
            cleared += 1
        except Exception:
            logger.exception("cleanup_stale_pending failed sub=%s", row.get("subscriber_id"))
    return {"cleared": cleared}
