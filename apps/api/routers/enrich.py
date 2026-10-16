"""Enrichment router.

Routes (LYCERT_ENRICHMENT_ARCHITECTURE.md Part 7):

  POST /api/v1/subscribers/{subscriber_id}/enrich
  POST /api/v1/tenants/{tenant_id}/enrich/batch
  GET  /api/v1/enrichment/jobs/{job_id}
  POST /api/v1/subscribers/{subscriber_id}/pre-enrich
  POST /api/v1/tenants/{tenant_id}/pre-enrich/batch  ← called by import flow
  GET  /api/v1/enrichment/coverage
"""

import json
import logging
import os
from typing import Any

from fastapi import (
    APIRouter, BackgroundTasks, Body, Depends, HTTPException, Request, Response, status,
)
from supabase import create_client

from middleware.auth import require_auth
from models.base import OkResponse, TenantContext
from services.enrichment.orchestrator import enrich_subscriber, enrich_all_subscribers
from services.enrichment.pre_enrichment import run_pre_enrichment
from services.enrichment.async_webhook import process_results, cleanup_stale_pending
from services.enrichment.providers.fullenrich_client import (
    verify_signature,
    signature_header_name,
)

logger = logging.getLogger(__name__)
router = APIRouter(tags=["enrichment"])

_ALLOWED_ROLES = {"owner", "admin", "manager"}
_ADMIN_ROLES = {"owner", "admin"}


def _check_role(ctx: TenantContext, roles: set[str] = _ALLOWED_ROLES) -> None:
    if ctx.role not in roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "forbidden", "message": "Insufficient role"},
        )


def _db():
    return create_client(
        os.environ["LYCERT_SUPABASE_URL"],
        os.environ["LYCERT_SUPABASE_SERVICE_ROLE_KEY"],
    )


# ── Paid enrichment ────────────────────────────────────────────────────────────

@router.post("/subscribers/{subscriber_id}/enrich", response_model=OkResponse)
async def enrich_one(
    subscriber_id: str,
    ctx: TenantContext = Depends(require_auth),
) -> OkResponse:
    """Trigger paid enrichment for one subscriber (PDL → Apollo → Identify fallback)."""
    _check_role(ctx)
    result = await enrich_subscriber(subscriber_id, ctx.tenant_id)
    return OkResponse(data=result)


@router.post("/tenants/{tenant_id}/enrich/batch", response_model=OkResponse)
async def enrich_batch(
    tenant_id: str,
    body: dict[str, Any] = Body(default={}),
    ctx: TenantContext = Depends(require_auth),
) -> OkResponse:
    """Batch enrichment for all qualifying subscribers. force=true overrides 30-day cache."""
    _check_role(ctx)
    if ctx.tenant_id != tenant_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Wrong tenant")
    result = await enrich_all_subscribers(tenant_id, force=bool(body.get("force", False)))
    return OkResponse(data=result)


# ── Job status (Part 7) ────────────────────────────────────────────────────────

@router.get("/enrichment/jobs/{job_id}", response_model=OkResponse)
async def get_enrichment_job(
    job_id: str,
    ctx: TenantContext = Depends(require_auth),
) -> OkResponse:
    """Poll enrichment job status and cost summary."""
    db = _db()
    row = (
        db.table("enrichment_jobs")
        .select("id, job_type, trigger_reason, status, total_count, success_count, miss_count, "
                "low_quality_count, error_count, pdl_credits_consumed, estimated_cost_usd, "
                "started_at, completed_at, error_message")
        .eq("id", job_id)
        .eq("tenant_id", ctx.tenant_id)
        .maybe_single()
        .execute()
    ).data
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    return OkResponse(data=row)


# ── Coverage stats (Part 7) ────────────────────────────────────────────────────

@router.get("/enrichment/coverage", response_model=OkResponse)
async def enrichment_coverage(
    ctx: TenantContext = Depends(require_auth),
) -> OkResponse:
    """Enrichment coverage stats: total, enriched count, miss count, rate %, estimated cost."""
    _check_role(ctx, _ADMIN_ROLES)
    db = _db()

    total_resp = (
        db.table("subscribers")
        .select("id", count="exact")
        .eq("tenant_id", ctx.tenant_id)
        .execute()
    )
    total = total_resp.count or 0

    enriched_resp = (
        db.table("subscriber_enrichment")
        .select("subscriber_id, enrichment_provider", count="exact")
        .eq("tenant_id", ctx.tenant_id)
        .execute()
    )
    enriched = enriched_resp.count or 0
    rows = enriched_resp.data or []

    miss_count = sum(1 for r in rows if r.get("enrichment_provider") == "pdl" and r.get("provider_miss_reason"))

    from datetime import datetime, timezone
    month_start = datetime.now(timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat()
    cost_resp = (
        db.table("enrichment_jobs")
        .select("pdl_credits_consumed, estimated_cost_usd")
        .eq("tenant_id", ctx.tenant_id)
        .eq("status", "completed")
        .gte("completed_at", month_start)
        .execute()
    )
    monthly_credits = sum(r.get("pdl_credits_consumed", 0) for r in (cost_resp.data or []))
    monthly_cost = sum(float(r.get("estimated_cost_usd") or 0) for r in (cost_resp.data or []))

    return OkResponse(data={
        "total_subscribers": total,
        "enriched_count": enriched,
        "miss_count": miss_count,
        "enrichment_rate_pct": round((enriched / total * 100) if total else 0, 1),
        "monthly_credits_consumed": monthly_credits,
        "monthly_cost_usd": round(monthly_cost, 2),
    })


# ── FullEnrich async webhook (PUBLIC — signature-authenticated, no JWT) ─────────

@router.post("/enrichment/webhook/fullenrich")
async def fullenrich_webhook(
    request: Request,
    background_tasks: BackgroundTasks,
) -> Response:
    """Receive FullEnrich async enrichment results (Part 4.3).

    External caller → no JWT. Auth is SHA1 signature verification against the API key.
    Responds 200 quickly and processes in the background (FullEnrich retries on non-2xx).
    Processing is idempotent (dedupe on enrichment_id + subscriber_id).
    """
    raw = await request.body()
    signature = request.headers.get(signature_header_name())
    if not verify_signature(raw, signature):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "invalid_signature", "message": "Webhook signature verification failed"},
        )
    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "invalid_payload", "message": "Body is not valid JSON"},
        )

    enrichment_id = payload.get("id") or payload.get("enrichment_id")
    background_tasks.add_task(process_results, payload, enrichment_id)
    return Response(status_code=status.HTTP_200_OK)


@router.post("/enrichment/maintenance/expire-async-pending", response_model=OkResponse)
async def expire_async_pending(
    ctx: TenantContext = Depends(require_auth),
) -> OkResponse:
    """Nightly timeout sweep (Part 4.3): clear pending_async_provider older than 24h.
    Admin/owner only; intended to be invoked by a scheduled job."""
    _check_role(ctx, _ADMIN_ROLES)
    result = cleanup_stale_pending()
    return OkResponse(data=result)


# ── Free pre-enrichment ────────────────────────────────────────────────────────

@router.post("/subscribers/{subscriber_id}/pre-enrich", response_model=OkResponse)
async def pre_enrich_one(
    subscriber_id: str,
    ctx: TenantContext = Depends(require_auth),
) -> OkResponse:
    """Free pre-enrichment: School Cleaner + Location Cleaner + email domain classification.
    No credits. Updates subscriber columns synchronously and returns updated fields.
    """
    _check_role(ctx)
    db = _db()
    sub = (
        db.table("subscribers")
        .select("id, email, institution_name, account_location, institution_location, "
                "stated_graduation_date, auto_renew")
        .eq("id", subscriber_id)
        .eq("tenant_id", ctx.tenant_id)
        .maybe_single()
        .execute()
    ).data
    if not sub:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Subscriber not found")

    updates = await run_pre_enrichment(sub, db=db)
    if updates:
        db.table("subscribers").update(updates).eq("id", subscriber_id).execute()

    return OkResponse(data={"subscriber_id": subscriber_id, "updated_fields": list(updates.keys())})


@router.post("/tenants/{tenant_id}/pre-enrich/batch", response_model=OkResponse)
async def pre_enrich_batch(
    tenant_id: str,
    background_tasks: BackgroundTasks,
    body: dict[str, Any] = Body(default={}),
    ctx: TenantContext = Depends(require_auth),
) -> OkResponse:
    """Run free pre-enrichment for a list of subscriber IDs (or all in tenant).
    Called automatically by the import flow after subscriber upsert.
    Runs as a background task — returns immediately.
    """
    _check_role(ctx)
    if ctx.tenant_id != tenant_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Wrong tenant")

    subscriber_ids: list[str] = body.get("subscriber_ids", [])

    async def _run_batch() -> None:
        try:
            db = _db()
            # Fetch subscribers (either specific IDs or all without pre-enrichment)
            if subscriber_ids:
                q = (
                    db.table("subscribers")
                    .select("id, email, institution_name, account_location, institution_location, "
                            "stated_graduation_date, auto_renew")
                    .eq("tenant_id", tenant_id)
                    .in_("id", subscriber_ids)
                )
            else:
                q = (
                    db.table("subscribers")
                    .select("id, email, institution_name, account_location, institution_location, "
                            "stated_graduation_date, auto_renew")
                    .eq("tenant_id", tenant_id)
                    .is_("email_domain_type", "null")
                )
            subs = (q.execute()).data or []

            for sub in subs:
                try:
                    updates = await run_pre_enrichment(sub, db=db)
                    if updates:
                        db.table("subscribers").update(updates).eq("id", sub["id"]).execute()
                except Exception:
                    logger.exception("pre_enrich_batch failed sub=%s", sub.get("id"))
        except Exception:
            logger.exception("pre_enrich_batch _run_batch outer error tenant=%s", tenant_id)

    background_tasks.add_task(_run_batch)
    return OkResponse(data={"queued": len(subscriber_ids) or "all", "tenant_id": tenant_id})
