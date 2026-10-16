"""Credit tracker — logs enrichment job costs to enrichment_jobs table.

Implements Part 8.2 of LYCERT_ENRICHMENT_ARCHITECTURE.md.
Also enforces budget limits from tenant_scoring_config (Part 8.1):
  - 80% threshold → logs warning (email alert in Phase 3 when Resend is live)
  - 100% threshold → blocks auto-enrichment (manual enrichment still allowed)
"""

import logging
import os
from datetime import datetime, timezone
from typing import Any

from supabase import create_client, Client

logger = logging.getLogger(__name__)

_PDL_COST_PER_CREDIT = 0.28  # update if PDL pricing changes


def _db() -> Client:
    return create_client(
        os.environ["LYCERT_SUPABASE_URL"],
        os.environ["LYCERT_SUPABASE_SERVICE_ROLE_KEY"],
    )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Job lifecycle ──────────────────────────────────────────────────────────────

def create_job(
    db: Client,
    tenant_id: str,
    job_type: str,
    trigger_reason: str,
    subscriber_ids: list[str],
) -> str:
    """Insert an enrichment_jobs row with status='running'. Returns job id."""
    resp = db.table("enrichment_jobs").insert({
        "tenant_id": tenant_id,
        "job_type": job_type,
        "trigger_reason": trigger_reason,
        "status": "running",
        "subscriber_ids": subscriber_ids,
        "total_count": len(subscriber_ids),
        "started_at": _now(),
    }).execute()
    rows = resp.data or []
    return rows[0].get("id", "") if rows else ""


def accumulate_provider_stat(
    stats: dict[str, dict[str, Any]],
    provider_key: str,
    *,
    hit: bool,
    cost_usd: float,
) -> None:
    """Accumulate one provider attempt into a per_provider_stats dict (V2 Part 3.4).
    Shape: {"hunter": {"attempts": N, "hits": M, "cost_usd": X}, ...}. Mutates in place."""
    entry = stats.setdefault(provider_key, {"attempts": 0, "hits": 0, "cost_usd": 0.0})
    entry["attempts"] += 1
    if hit:
        entry["hits"] += 1
    entry["cost_usd"] = round(entry["cost_usd"] + (cost_usd or 0.0), 4)


def complete_job(
    db: Client,
    job_id: str,
    success_count: int,
    miss_count: int,
    low_quality_count: int,
    error_count: int,
    pdl_credits: int,
    apollo_credits: int = 0,
    per_provider_stats: dict[str, dict[str, Any]] | None = None,
    async_pending_count: int = 0,
) -> None:
    """Record enrichment job completion with full cost accounting (Part 8.2 + V2 Part 3.4).

    estimated_cost_usd sums across ALL providers when per_provider_stats is supplied
    (V2 budget meters across providers); otherwise falls back to PDL-only accounting for
    backward compatibility. pdl_credits / apollo_credits columns are retained.
    """
    if not job_id:
        return
    if per_provider_stats:
        estimated_cost = round(sum(p.get("cost_usd", 0.0) for p in per_provider_stats.values()), 4)
    else:
        estimated_cost = round(pdl_credits * _PDL_COST_PER_CREDIT, 4)
    try:
        db.table("enrichment_jobs").update({
            "status": "completed",
            "success_count": success_count,
            "miss_count": miss_count,
            "low_quality_count": low_quality_count,
            "error_count": error_count,
            "pdl_credits_consumed": pdl_credits,
            "apollo_credits_consumed": apollo_credits,
            "per_provider_stats": per_provider_stats or {},
            "async_pending_count": async_pending_count,
            "estimated_cost_usd": estimated_cost,
            "completed_at": _now(),
        }).eq("id", job_id).execute()
    except Exception:
        logger.exception("complete_job failed job=%s", job_id)


def fail_job(db: Client, job_id: str, error_message: str) -> None:
    if not job_id:
        return
    try:
        db.table("enrichment_jobs").update({
            "status": "failed",
            "error_message": error_message[:500],
            "completed_at": _now(),
        }).eq("id", job_id).execute()
    except Exception:
        logger.exception("fail_job failed job=%s", job_id)


# ── Budget enforcement (Part 8.1) ──────────────────────────────────────────────

def get_monthly_usage(db: Client, tenant_id: str) -> int:
    """Return total successful enrichments this calendar month for the tenant.

    V2 Part 6: monthly_enrichment_budget meters ACROSS all providers — it counts successful
    paid lookups from any provider (= success_count per job), not PDL credits alone.
    (0022 comment: budget is "max enrichments per calendar month".)
    """
    month_start = datetime.now(timezone.utc).replace(
        day=1, hour=0, minute=0, second=0, microsecond=0
    ).isoformat()
    resp = (
        db.table("enrichment_jobs")
        .select("success_count")
        .eq("tenant_id", tenant_id)
        .eq("status", "completed")
        .gte("completed_at", month_start)
        .execute()
    )
    return sum(r.get("success_count", 0) for r in (resp.data or []))


def check_budget(db: Client, tenant_id: str, requested: int) -> dict[str, Any]:
    """Check whether requested enrichments fit within the tenant's monthly budget.

    Returns:
      {"allowed": True}
        — proceed
      {"allowed": False, "reason": "budget_exhausted"}
        — auto-enrichment blocked; manual still allowed
      {"allowed": True, "warning": "budget_80pct", "pct_used": float}
        — allowed but owner should be notified
    """
    config_resp = (
        db.table("tenant_scoring_config")
        .select("monthly_enrichment_budget, enrichment_auto_trigger")
        .eq("tenant_id", tenant_id)
        .maybe_single()
        .execute()
    )
    config = config_resp.data or {}
    budget = config.get("monthly_enrichment_budget")

    if budget is None:
        return {"allowed": True}  # unlimited (enterprise)

    used = get_monthly_usage(db, tenant_id)
    pct_used = (used / budget) * 100 if budget > 0 else 100.0

    if used >= budget:
        logger.warning("budget_exhausted tenant=%s used=%d budget=%d", tenant_id, used, budget)
        return {"allowed": False, "reason": "budget_exhausted", "pct_used": pct_used}

    if (used + requested) / budget >= 0.80:
        logger.warning("budget_80pct tenant=%s used=%d budget=%d", tenant_id, used, budget)
        return {"allowed": True, "warning": "budget_80pct", "pct_used": pct_used}

    return {"allowed": True}
