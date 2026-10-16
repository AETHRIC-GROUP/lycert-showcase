# ┌─────────────────────────────────────────────────────────────────────────────┐
# │ SUPERSEDED / REFERENCE IMPLEMENTATION (2026-06-13)                            │
# │ The product is consolidating on the TypeScript engine (Supabase + Vercel);    │
# │ Railway/Python is retired as a runtime. This module is the REFERENCE we port  │
# │ FROM — kept green, not deleted, removed only after the TS engine reaches       │
# │ parity. Do not wire new runtime callers to it. See ENGINE_CONSOLIDATION_PLAN.md │
# │ and DECISIONS.md 2026-06-13 (engine consolidation).                            │
# └─────────────────────────────────────────────────────────────────────────────┘
"""Enrichment orchestrator — registry-driven waterfall (LYCERT_WATERFALL_ENRICHMENT_V2.md).

Supersedes the hardcoded PDL→Apollo chain with a configurable cascade:

  STAGE 0  ZeroBounce validate     → invalid/disposable: STOP (no paid lookup ever runs)
  STEP 1   Hunter people/find      → partial only, never stops the waterfall
  STEP 2   ReverseContact          → COMPLETE possible (personal-email specialist)
  STEP 3   Datagma /full           → COMPLETE possible (real-time)
  STEP 4   PDL person/enrich        → COMPLETE possible (best education data)
  STEP 5   FullEnrich reverse lookup → async final sweep (priority >= 40 only)

Order + enable flags come from enrichment_providers (global default) overlaid with
tenant_waterfall_config (per tenant). Fields from multiple providers merge under Part 5
rules (services/enrichment/merge.py). Stage-0 results cache for 180 days.

Preserved from the prior orchestrator: enrich_subscriber / enrich_all_subscribers entry
points, budget checks, lifecycle gating, enrichment_jobs tracking, and the company-enrichment
trigger after a strong PDL hit. The scoring engine is untouched (provider-agnostic).
"""

import logging
import os
from collections import Counter
from datetime import datetime, timezone, timedelta
from typing import Any

from supabase import create_client, Client

from services.enrichment.company_enrichment import run_company_enrichment
from services.enrichment.merge import merge_fields
from services.enrichment import credit_tracker
from services.enrichment.providers import PROVIDER_REGISTRY
from services.enrichment.providers.base import ProviderOutcome, classify_completeness
from services.enrichment.providers.zerobounce_client import ZeroBounceClient
from services.enrichment.providers.fullenrich_client import FullEnrichClient

logger = logging.getLogger(__name__)

_RETENTION_DAYS = 30
_VALIDATION_CACHE_DAYS = 180
_ASYNC_PRIORITY_THRESHOLD = 40

_QUALIFYING_STAGES = {"approaching_graduation", "post_graduation_unverified"}
_LOCKED_STAGES = {"converted", "churned", "dismissed"}
_BLOCKING_VALIDATION_STATUSES = {"invalid", "disposable"}

_SUB_SELECT = (
    "id, email, name, lifecycle_stage, institution_name, account_country, "
    "account_country_normalized, enrichment_priority, email_validation_status, email_validated_at"
)


def _db() -> Client:
    return create_client(
        os.environ["LYCERT_SUPABASE_URL"],
        os.environ["LYCERT_SUPABASE_SERVICE_ROLE_KEY"],
    )


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── Cascade loading (registry + tenant override) ───────────────────────────────

def load_cascade(db: Client, tenant_id: str) -> list[dict[str, Any]]:
    """Return ordered enrichment-provider metadata for the cascade (validation stage excluded).

    Global default order from enrichment_providers.default_position, overlaid with any
    tenant_waterfall_config rows (which set per-tenant position + enable). Disabled providers
    are dropped.
    """
    try:
        providers = (
            db.table("enrichment_providers")
            .select("provider_key, provider_type, execution_mode, enabled, default_position")
            .eq("provider_type", "enrichment")
            .execute()
        ).data or []
    except Exception:
        logger.exception("load_cascade: failed to read enrichment_providers")
        return []

    overrides = {}
    try:
        for row in (
            db.table("tenant_waterfall_config")
            .select("provider_key, position, enabled")
            .eq("tenant_id", tenant_id)
            .execute()
        ).data or []:
            overrides[row["provider_key"]] = row
    except Exception:
        logger.exception("load_cascade: failed to read tenant_waterfall_config tenant=%s", tenant_id)

    cascade: list[dict[str, Any]] = []
    for p in providers:
        key = p["provider_key"]
        ov = overrides.get(key)
        enabled = ov["enabled"] if ov else p["enabled"]
        if not enabled or key not in PROVIDER_REGISTRY:
            continue
        position = ov["position"] if ov else p.get("default_position")
        if position is None:
            continue
        cascade.append({
            "provider_key": key,
            "execution_mode": p["execution_mode"],
            "position": position,
        })
    cascade.sort(key=lambda c: c["position"])
    return cascade


# ── Stage 0 — ZeroBounce validation gate (cached 180 days) ─────────────────────

def _validation_is_fresh(sub: dict[str, Any]) -> bool:
    validated_at = sub.get("email_validated_at")
    if not validated_at or not sub.get("email_validation_status"):
        return False
    try:
        ts = datetime.fromisoformat(str(validated_at).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return False
    return (_now() - ts) < timedelta(days=_VALIDATION_CACHE_DAYS)


async def _run_stage0(
    db: Client, sub: dict[str, Any], stats: dict[str, Any]
) -> bool:
    """Validate the subscriber's email if not freshly cached. Returns True if the waterfall
    must be SKIPPED (invalid / disposable). Never blocks on a ZeroBounce outage or missing key.
    """
    if _validation_is_fresh(sub):
        return sub.get("email_validation_status") in _BLOCKING_VALIDATION_STATUSES

    if not os.environ.get("LYCERT_ZEROBOUNCE_API_KEY"):
        return False  # cannot validate — proceed, don't lose coverage (Part 1.1)

    result = await ZeroBounceClient().validate(sub["email"])
    credit_tracker.accumulate_provider_stat(
        stats, "zerobounce", hit=True, cost_usd=result.cost_usd
    )
    updates: dict[str, Any] = {
        "email_validation_status": result.status,
        "email_validated_at": _now().isoformat(),
    }
    if result.did_you_mean:
        updates["email_typo_suggestion"] = result.did_you_mean  # surface only, never auto-correct
    if result.email_domain_type_override:
        updates["email_domain_type"] = result.email_domain_type_override  # disposable → B1 signal
    try:
        db.table("subscribers").update(updates).eq("id", sub["id"]).execute()
    except Exception:
        logger.exception("_run_stage0 subscriber update failed sub=%s", sub.get("id"))
    sub.update(updates)
    return result.blocks_enrichment


async def prewarm_validation(db: Client, subs: list[dict[str, Any]], stats: dict[str, Any]) -> None:
    """Batch-validate (≤200/call) any subscribers without a fresh cached validation, writing
    results to subscribers so the row-wise cascade reads them from cache (Part 4.2)."""
    if not os.environ.get("LYCERT_ZEROBOUNCE_API_KEY"):
        return
    stale = [s for s in subs if not _validation_is_fresh(s) and s.get("email")]
    client = ZeroBounceClient()
    for i in range(0, len(stale), 200):
        chunk = stale[i : i + 200]
        try:
            results = await client.validate_batch([s["email"] for s in chunk])
        except Exception:
            logger.exception("prewarm_validation batch failed")
            continue
        for s in chunk:
            res = results.get(s["email"])
            if not res:
                continue
            credit_tracker.accumulate_provider_stat(stats, "zerobounce", hit=True, cost_usd=res.cost_usd)
            updates: dict[str, Any] = {
                "email_validation_status": res.status,
                "email_validated_at": _now().isoformat(),
            }
            if res.did_you_mean:
                updates["email_typo_suggestion"] = res.did_you_mean
            if res.email_domain_type_override:
                updates["email_domain_type"] = res.email_domain_type_override
            try:
                db.table("subscribers").update(updates).eq("id", s["id"]).execute()
            except Exception:
                logger.exception("prewarm_validation update failed sub=%s", s.get("id"))
            s.update(updates)


# ── Persistence ────────────────────────────────────────────────────────────────

def _majority_provider(provenance: dict[str, str], fallback: str) -> str:
    if not provenance:
        return fallback
    return Counter(provenance.values()).most_common(1)[0][0]


def _persist_enrichment(
    db: Client,
    sub: dict[str, Any],
    tenant_id: str,
    merged: dict[str, Any],
    provenance: dict[str, str],
    attempted: list[dict[str, str]],
    completeness: str,
    pending_async_provider: str | None,
    miss_reason: str | None,
) -> None:
    now = _now()
    record: dict[str, Any] = {
        "subscriber_id": sub["id"],
        "tenant_id": tenant_id,
        "enrichment_provider": _majority_provider(
            provenance, pending_async_provider or (attempted[-1]["provider"] if attempted else "pdl")
        ),
        "field_provenance": provenance,
        "providers_attempted": attempted,
        "completeness": completeness,
        "pending_async_provider": pending_async_provider,
        "enriched_at": now.isoformat(),
        "delete_at": (now + timedelta(days=_RETENTION_DAYS)).isoformat(),
    }
    if miss_reason:
        record["provider_miss_reason"] = miss_reason
    record.update({k: v for k, v in merged.items() if v is not None})
    try:
        db.table("subscriber_enrichment").upsert(record, on_conflict="subscriber_id").execute()
    except Exception:
        logger.exception("_persist_enrichment failed sub=%s", sub.get("id"))


def _write_audit(db: Client, tenant_id: str, subscriber_id: str, provider: str) -> None:
    try:
        db.table("audit_logs").insert({
            "tenant_id": tenant_id,
            "actor_type": "system",
            "actor_id": None,
            "action": "subscriber.enriched",
            "resource_type": "subscriber",
            "resource_id": subscriber_id,
            "metadata": {"provider": provider},
        }).execute()
    except Exception:
        logger.exception("audit_log write failed sub=%s", subscriber_id)


def _trigger_scoring(db: Client, tenant_id: str, subscriber_id: str) -> None:
    try:
        db.table("audit_logs").insert({
            "tenant_id": tenant_id,
            "actor_type": "system",
            "actor_id": None,
            "action": "subscriber.scoring_queued",
            "resource_type": "subscriber",
            "resource_id": subscriber_id,
            "metadata": {"trigger": "post_enrichment"},
        }).execute()
    except Exception:
        logger.exception("_trigger_scoring failed sub=%s", subscriber_id)


def _record_gap(db: Client, sub: dict[str, Any], tenant_id: str, reason: str) -> None:
    """Record a data gap (e.g. email_undeliverable) without spending any paid lookup."""
    _persist_enrichment(
        db, sub, tenant_id, merged={}, provenance={}, attempted=[],
        completeness="miss", pending_async_provider=None, miss_reason=reason,
    )


def _set_deferred(db: Client, subscriber_id: str) -> None:
    try:
        db.table("subscribers").update({"enrichment_deferred": True}).eq("id", subscriber_id).execute()
    except Exception:
        logger.exception("set_deferred failed sub=%s", subscriber_id)


def _get_latest_score(db: Client, subscriber_id: str) -> dict[str, Any] | None:
    try:
        return (
            db.table("subscriber_scores")
            .select("confidence_tier, aec_professional_confirmed")
            .eq("subscriber_id", subscriber_id)
            .order("scored_at", desc=True)
            .limit(1)
            .maybe_single()
            .execute()
        ).data
    except Exception:
        return None


def _qualifies_for_enrichment(sub: dict[str, Any]) -> bool:
    stage = sub.get("lifecycle_stage", "")
    if stage in _LOCKED_STAGES:
        return False
    return stage in _QUALIFYING_STAGES


def _needs_async_sweep(merged: dict[str, Any], sub: dict[str, Any]) -> bool:
    """Part 2.3: after the sync cascade, sweep with FullEnrich only when the record is not
    COMPLETE AND the subscriber's enrichment_priority >= 40."""
    if classify_completeness(merged) == ProviderOutcome.COMPLETE:
        return False
    return (sub.get("enrichment_priority") or 0) >= _ASYNC_PRIORITY_THRESHOLD


# ── Core per-subscriber cascade ────────────────────────────────────────────────

async def run_waterfall(
    db: Client,
    sub: dict[str, Any],
    tenant_id: str,
    cascade: list[dict[str, Any]],
    stats: dict[str, Any],
    job_id: str | None,
) -> dict[str, Any]:
    """Run the full waterfall for one subscriber: Stage 0 → sync cascade (merge + stop on
    COMPLETE) → async handoff. Persists the merged record. Returns a summary dict.
    """
    subscriber_id = sub["id"]

    # Stage 0 gate — no override flag, by design (Part 9).
    if await _run_stage0(db, sub, stats):
        _record_gap(db, sub, tenant_id, "email_undeliverable")
        return {"completeness": "miss", "provider": None, "pending": None, "blocked": True}

    merged: dict[str, Any] = {}
    provenance: dict[str, str] = {}
    attempted: list[dict[str, str]] = []
    pending_provider: str | None = None
    pdl_likelihood = 0

    for step in cascade:
        key = step["provider_key"]
        if step["execution_mode"] == "async":
            if _needs_async_sweep(merged, sub):
                client = FullEnrichClient(job_id=job_id)
                result = await client.enrich(sub["email"], sub.get("name"), subscriber_id)
                if result.outcome == ProviderOutcome.PENDING and result.async_reference:
                    pending_provider = key
                    attempted.append({"provider": key, "outcome": "pending"})
            break  # async is always terminal in the sync loop

        provider = PROVIDER_REGISTRY[key]()
        result = await provider.enrich(sub["email"], sub.get("name"), subscriber_id)

        hit = result.outcome in (ProviderOutcome.COMPLETE, ProviderOutcome.PARTIAL)
        credit_tracker.accumulate_provider_stat(
            stats, key, hit=hit, cost_usd=result.cost_usd if result.charged else 0.0
        )

        outcome_label = result.outcome.value
        merge_status = merge_fields(merged, provenance, result, sub.get("name"))
        if merge_status == "mismatch":
            outcome_label = "mismatch"
        attempted.append({"provider": key, "outcome": outcome_label})

        if key == "pdl" and result.fields.get("pdl_likelihood_score"):
            pdl_likelihood = result.fields["pdl_likelihood_score"]

        if classify_completeness(merged) == ProviderOutcome.COMPLETE:
            break

    completeness = classify_completeness(merged).value
    miss_reason = "no_match" if (completeness == "miss" and not pending_provider) else None
    _persist_enrichment(
        db, sub, tenant_id, merged, provenance, attempted,
        completeness, pending_provider, miss_reason,
    )

    if merged:
        majority = _majority_provider(provenance, "pdl")
        _write_audit(db, tenant_id, subscriber_id, majority)
        await _maybe_company_enrichment(db, sub, subscriber_id, tenant_id, merged, pdl_likelihood)
        _trigger_scoring(db, tenant_id, subscriber_id)

    return {
        "completeness": completeness,
        "provider": _majority_provider(provenance, None) if merged else None,
        "pending": pending_provider,
        "blocked": False,
    }


async def _maybe_company_enrichment(
    db: Client,
    sub: dict[str, Any],
    subscriber_id: str,
    tenant_id: str,
    merged: dict[str, Any],
    pdl_likelihood: int,
) -> None:
    """Secondary company enrichment — PDL-gated (likelihood >= 6), unchanged from Part 1.5."""
    if pdl_likelihood < 6:
        return
    latest = _get_latest_score(db, subscriber_id) or {}
    sub_with_score = {
        **sub,
        "_latest_confidence_tier": latest.get("confidence_tier"),
        "_aec_professional_confirmed": latest.get("aec_professional_confirmed", False),
    }
    try:
        await run_company_enrichment(db, subscriber_id, tenant_id, sub_with_score, pdl_likelihood, merged)
    except Exception:
        logger.exception("company_enrichment failed sub=%s", subscriber_id)


# ── Public API ─────────────────────────────────────────────────────────────────

def _any_provider_configured() -> bool:
    return any(
        os.environ.get(v)
        for v in (
            "LYCERT_PDL_API_KEY", "LYCERT_HUNTER_API_KEY", "LYCERT_REVERSECONTACT_API_KEY",
            "LYCERT_DATAGMA_API_KEY", "LYCERT_FULLENRICH_API_KEY",
        )
    )


async def enrich_subscriber(
    subscriber_id: str,
    tenant_id: str,
    force: bool = False,
) -> dict[str, Any]:
    """Enrich a single subscriber via the configured waterfall.

    status: 'enriched' | 'pending_async' | 'no_api_key' | 'not_qualifying' |
            'budget_exhausted' | 'empty_result' | 'blocked' | 'error'
    """
    if not _any_provider_configured():
        return {"status": "no_api_key"}

    db = _db()
    sub = (
        db.table("subscribers").select(_SUB_SELECT)
        .eq("id", subscriber_id).eq("tenant_id", tenant_id).maybe_single().execute()
    ).data
    if not sub:
        return {"status": "error", "message": "Subscriber not found"}

    if not force and not _qualifies_for_enrichment(sub):
        _set_deferred(db, subscriber_id)
        return {"status": "not_qualifying", "lifecycle_stage": sub.get("lifecycle_stage")}

    budget_check = credit_tracker.check_budget(db, tenant_id, requested=1)
    if not budget_check["allowed"]:
        return {"status": "budget_exhausted", **budget_check}

    cascade = load_cascade(db, tenant_id)
    job_id = credit_tracker.create_job(db, tenant_id, "single", "manual", [subscriber_id])
    stats: dict[str, Any] = {}

    try:
        summary = await run_waterfall(db, sub, tenant_id, cascade, stats, job_id)
    except Exception as exc:
        logger.exception("enrich_subscriber failed sub=%s", subscriber_id)
        credit_tracker.fail_job(db, job_id, str(exc))
        return {"status": "error", "message": "Internal error"}

    enriched = summary["completeness"] in ("complete", "partial")
    credit_tracker.complete_job(
        db, job_id,
        success_count=1 if enriched else 0,
        miss_count=0 if (enriched or summary["pending"]) else 1,
        low_quality_count=0,
        error_count=0,
        pdl_credits=int(stats.get("pdl", {}).get("hits", 0)),
        apollo_credits=int(stats.get("apollo", {}).get("hits", 0)),
        per_provider_stats=stats,
        async_pending_count=1 if summary["pending"] else 0,
    )

    if summary.get("blocked"):
        return {"status": "blocked", "reason": "email_undeliverable", "job_id": job_id}
    if summary["pending"]:
        return {"status": "pending_async", "provider": summary["pending"], "job_id": job_id}
    if not enriched:
        return {"status": "empty_result", "provider": None, "job_id": job_id}
    return {"status": "enriched", "provider": summary["provider"],
            "completeness": summary["completeness"], "job_id": job_id}


async def enrich_all_subscribers(
    tenant_id: str,
    force: bool = False,
) -> dict[str, Any]:
    """Batch enrichment for all qualifying subscribers.

    Stage 0 is pre-warmed in batches of 200; the sync cascade runs row-wise (Hunter /
    ReverseContact / Datagma are sequential and rate-limited; PDL runs per-row inside the
    cascade because stop-on-complete makes the PDL-needing set emergent). FullEnrich async
    sweeps are submitted in bulk (≤100) after the sync cascade.
    """
    if not _any_provider_configured():
        return {"status": "no_api_key", "total": 0}

    db = _db()
    all_subs = (
        db.table("subscribers").select(_SUB_SELECT)
        .eq("tenant_id", tenant_id)
        .in_("lifecycle_stage", list(_QUALIFYING_STAGES))
        .execute()
    ).data or []

    if not force:
        cutoff = (_now() - timedelta(days=_RETENTION_DAYS)).isoformat()
        recently = {
            r["subscriber_id"]
            for r in (
                db.table("subscriber_enrichment").select("subscriber_id")
                .eq("tenant_id", tenant_id).gte("enriched_at", cutoff).execute()
            ).data or []
        }
        to_enrich = [s for s in all_subs if s["id"] not in recently]
    else:
        to_enrich = all_subs

    if not to_enrich:
        return {"status": "complete", "total": 0, "enriched": 0, "miss": 0, "pending": 0, "error": 0}

    budget_check = credit_tracker.check_budget(db, tenant_id, requested=len(to_enrich))
    if not budget_check["allowed"]:
        return {"status": "budget_exhausted", "total": len(to_enrich), **budget_check}

    cascade = load_cascade(db, tenant_id)
    job_id = credit_tracker.create_job(db, tenant_id, "batch", "manual", [s["id"] for s in to_enrich])
    stats: dict[str, Any] = {}
    totals = {"enriched": 0, "miss": 0, "pending": 0, "error": 0}

    # Stage 0 batch pre-warm (≤200/call) so per-row Stage 0 reads from cache.
    await prewarm_validation(db, to_enrich, stats)

    for sub in to_enrich:
        try:
            summary = await run_waterfall(db, sub, tenant_id, cascade, stats, job_id)
        except Exception:
            logger.exception("enrich_all run_waterfall error sub=%s", sub.get("id"))
            totals["error"] += 1
            continue
        if summary["pending"]:
            totals["pending"] += 1
        elif summary["completeness"] in ("complete", "partial"):
            totals["enriched"] += 1
        else:
            totals["miss"] += 1

    credit_tracker.complete_job(
        db, job_id,
        success_count=totals["enriched"],
        miss_count=totals["miss"],
        low_quality_count=0,
        error_count=totals["error"],
        pdl_credits=int(stats.get("pdl", {}).get("hits", 0)),
        apollo_credits=int(stats.get("apollo", {}).get("hits", 0)),
        per_provider_stats=stats,
        async_pending_count=totals["pending"],
    )

    return {
        "status": "complete",
        "job_id": job_id,
        "total": len(to_enrich),
        "enriched": totals["enriched"],
        "miss": totals["miss"],
        "pending": totals["pending"],
        "error": totals["error"],
        "per_provider_stats": stats,
        "estimated_cost_usd": round(sum(p.get("cost_usd", 0.0) for p in stats.values()), 4),
    }
