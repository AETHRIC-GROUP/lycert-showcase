"""Lifecycle stage computation and nightly evaluation job.

The lifecycle stage reflects where a subscriber currently stands relative to
their graduation date and the tenant's configured grace period. It is computed
at import time (synchronously) and updated nightly by the scheduled job.

Stage transitions are one-directional except for 'converted' and
're_verification_pending', which are set by external events (billing webhook
and subscriber action respectively) and are never overridden by date logic.
"""

import logging
import os
from datetime import date, timedelta
from typing import Any

from supabase import create_client, Client

logger = logging.getLogger(__name__)

# Stages set by external events — date logic must never override these.
_LOCKED_STAGES = {"converted", "churned", "dismissed"}


def _service_client() -> Client:
    url = os.getenv("LYCERT_SUPABASE_URL")
    key = os.getenv("LYCERT_SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise RuntimeError("LYCERT_SUPABASE_URL and LYCERT_SUPABASE_SERVICE_ROLE_KEY must be set")
    return create_client(url, key)


def compute_stage(
    stated_graduation_date: date | None,
    current_stage: str,
    grace_period_days: int = 90,
    today: date | None = None,
) -> str:
    """Pure function — returns the correct lifecycle stage for given inputs.

    Never raises. Returns current_stage unchanged when graduation date is
    absent or when the stage is locked by an external event.
    """
    if today is None:
        today = date.today()

    # Locked stages are controlled by billing/subscriber events, not dates.
    if current_stage in _LOCKED_STAGES:
        return current_stage

    # re_verification_pending is set when the subscriber starts a verification
    # flow. It clears via the verification result, not the date engine.
    if current_stage == "re_verification_pending":
        return current_stage

    if stated_graduation_date is None:
        return current_stage  # can't evaluate without a graduation date

    days_to_grad = (stated_graduation_date - today).days  # negative = past

    if days_to_grad > 90:
        return "active_student"
    elif days_to_grad > 0:
        return "approaching_graduation"
    elif days_to_grad >= -grace_period_days:
        # Within grace period after graduation — still considered active student
        return "active_student"
    else:
        return "post_graduation_unverified"


def run_lifecycle_job(tenant_id: str | None = None) -> dict[str, Any]:
    """Evaluate and update lifecycle stages for all tenants (or one if tenant_id given).

    Returns a summary dict with counts of evaluated / updated subscribers.
    Uses the service role key to bypass RLS — this is a system operation.
    """
    db = _service_client()
    today = date.today()
    total_evaluated = 0
    total_updated = 0
    tenant_summaries: list[dict] = []

    # ── 1. Fetch tenants to process ────────────────────────────────────────
    tenant_query = db.table("tenants").select("id")
    if tenant_id:
        tenant_query = tenant_query.eq("id", tenant_id)
    tenants_resp = tenant_query.execute()
    tenants = tenants_resp.data or []

    if not tenants:
        logger.info("lifecycle_job: no tenants found")
        return {"evaluated": 0, "updated": 0, "tenants": []}

    # ── 2. Fetch scoring configs for all tenants ───────────────────────────
    tenant_ids = [t["id"] for t in tenants]
    configs_resp = db.table("tenant_scoring_config").select("tenant_id,grace_period_days").in_("tenant_id", tenant_ids).execute()
    grace_period_map: dict[str, int] = {
        r["tenant_id"]: r["grace_period_days"]
        for r in (configs_resp.data or [])
    }

    # ── 3. Process each tenant ─────────────────────────────────────────────
    for tenant in tenants:
        tid = tenant["id"]
        grace_period_days = grace_period_map.get(tid, 90)  # default 90 days

        # Fetch all subscribers that date logic can affect
        subs_resp = (
            db.table("subscribers")
            .select("id,stated_graduation_date,lifecycle_stage")
            .eq("tenant_id", tid)
            .not_.in_("lifecycle_stage", list(_LOCKED_STAGES))
            .execute()
        )
        subscribers = subs_resp.data or []

        updated_ids: list[str] = []

        for sub in subscribers:
            total_evaluated += 1
            grad_str = sub.get("stated_graduation_date")
            grad_date = date.fromisoformat(grad_str) if grad_str else None
            current = sub["lifecycle_stage"]
            new_stage = compute_stage(grad_date, current, grace_period_days, today)

            if new_stage != current:
                # Update the subscriber
                db.table("subscribers").update({
                    "lifecycle_stage": new_stage
                }).eq("id", sub["id"]).execute()

                # Audit log
                try:
                    db.table("audit_logs").insert({
                        "tenant_id": tid,
                        "actor_type": "system",
                        "action": "subscriber.lifecycle_stage_updated",
                        "resource_type": "subscriber",
                        "resource_id": sub["id"],
                        "metadata": {
                            "previous_stage": current,
                            "new_stage": new_stage,
                            "job_date": today.isoformat(),
                        },
                    }).execute()
                except Exception:
                    logger.exception("lifecycle_job: failed to write audit log for subscriber %s", sub["id"])

                updated_ids.append(sub["id"])
                total_updated += 1

        tenant_summaries.append({
            "tenant_id": tid,
            "evaluated": len(subscribers),
            "updated": len(updated_ids),
        })
        logger.info(
            "lifecycle_job: tenant=%s evaluated=%d updated=%d",
            tid, len(subscribers), len(updated_ids),
        )

    return {
        "job_date": today.isoformat(),
        "evaluated": total_evaluated,
        "updated": total_updated,
        "tenants": tenant_summaries,
    }
