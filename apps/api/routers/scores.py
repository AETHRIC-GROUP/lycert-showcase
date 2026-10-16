import os
import logging
from datetime import date, datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from supabase import create_client
from middleware.auth import require_auth
from models.base import OkResponse, TenantContext
from scoring.engine import score_row
from scoring.models import ScoringConfig, SubscriberRecord

log = logging.getLogger(__name__)
router = APIRouter(tags=["scores"])


def _get_supabase():
    url = os.getenv("LYCERT_SUPABASE_URL")
    key = os.getenv("LYCERT_SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise HTTPException(status_code=503, detail="Supabase not configured")
    return create_client(url, key)


def _to_date(val: str | None) -> date | None:
    if not val:
        return None
    try:
        return date.fromisoformat(str(val)[:10])
    except Exception:
        return None


@router.post("/subscribers/{subscriber_id}/score", response_model=OkResponse)
async def score_subscriber(
    subscriber_id: str, ctx: TenantContext = Depends(require_auth)
) -> OkResponse:
    sb = _get_supabase()

    sub_res = sb.table("subscribers").select("*").eq("id", subscriber_id).eq("tenant_id", ctx.tenant_id).maybe_single().execute()
    if not sub_res.data:
        raise HTTPException(status_code=404, detail="Subscriber not found")

    cfg_res = sb.table("tenant_scoring_config").select("*").eq("tenant_id", ctx.tenant_id).maybe_single().execute()
    config = ScoringConfig(**(cfg_res.data or {}))

    sub = sub_res.data
    record = SubscriberRecord(
        email=sub.get("email", ""),
        account_name=sub.get("account_name") or "",
        institution_name=sub.get("institution_name") or "",
        institution_location=sub.get("institution_location") or "",
        account_country=sub.get("account_country") or "",
        stated_graduation_date=_to_date(sub.get("stated_graduation_date")),
        subscription_start_date=_to_date(sub.get("subscription_start_date")),
        subscription_end_date=_to_date(sub.get("subscription_end_date")),
        renewal_delta_days=sub.get("days_before_last_renewal"),
    )

    result = score_row(record, config, date.today())

    score_record = {
        "subscriber_id": subscriber_id,
        "tenant_id": ctx.tenant_id,
        "total_score": result.total_score,
        "confidence_tier": result.confidence_tier,
        "tier_label": result.tier_label,
        "data_confidence": result.data_confidence,
        "primary_signal": result.primary_signal or None,
        "supporting_signals": result.supporting_signals or None,
        "signals_count": result.signals_count,
        "signals_fired": result.signals_fired or None,
        "data_gaps": result.data_gaps or None,
        "aec_professional_confirmed": result.aec_professional_confirmed,
        "recommended_action": result.recommended_action,
        "scoring_version": result.scoring_version,
    }

    ins = sb.table("subscriber_scores").insert(score_record).execute()
    score_id = ins.data[0]["id"] if ins.data else None

    # Update subscriber.last_scored_at
    sb.table("subscribers").update({"last_scored_at": datetime.now(timezone.utc).isoformat()}).eq("id", subscriber_id).execute()

    # Create case for Tier 1 or Tier 2
    if result.confidence_tier in (1, 2) and score_id:
        existing = sb.table("cases").select("id").eq("subscriber_id", subscriber_id).in_("status", ["pending_review", "in_review"]).execute()
        if not existing.data:
            sb.table("cases").insert({
                "tenant_id": ctx.tenant_id,
                "subscriber_id": subscriber_id,
                "score_id": score_id,
                "status": "pending_review",
            }).execute()

    return OkResponse(data=score_record)


@router.post("/tenants/{tenant_id}/score/batch", response_model=OkResponse)
async def score_batch(
    tenant_id: str, ctx: TenantContext = Depends(require_auth)
) -> OkResponse:
    if tenant_id != ctx.tenant_id:
        raise HTTPException(status_code=403, detail="Forbidden")

    sb = _get_supabase()

    cfg_res = sb.table("tenant_scoring_config").select("*").eq("tenant_id", tenant_id).maybe_single().execute()
    config = ScoringConfig(**(cfg_res.data or {}))

    # Subscribers with no score or last scored > 30 days ago
    cutoff = date.fromordinal(date.today().toordinal() - 30).isoformat()
    subs_res = (
        sb.table("subscribers")
        .select("*")
        .eq("tenant_id", tenant_id)
        .or_(f"last_scored_at.is.null,last_scored_at.lt.{cutoff}")
        .execute()
    )
    subscribers = subs_res.data or []

    if not subscribers:
        return OkResponse(data={"scored": 0, "cases_created": 0, "message": "No subscribers need scoring"})

    scored = 0
    cases_created = 0
    reference = date.today()

    for sub in subscribers:
        try:
            record = SubscriberRecord(
                email=sub.get("email", ""),
                account_name=sub.get("account_name") or "",
                institution_name=sub.get("institution_name") or "",
                institution_location=sub.get("institution_location") or "",
                account_country=sub.get("account_country") or "",
                stated_graduation_date=_to_date(sub.get("stated_graduation_date")),
                subscription_start_date=_to_date(sub.get("subscription_start_date")),
                subscription_end_date=_to_date(sub.get("subscription_end_date")),
                renewal_delta_days=sub.get("days_before_last_renewal"),
            )
            result = score_row(record, config, reference)

            score_record = {
                "subscriber_id": sub["id"],
                "tenant_id": tenant_id,
                "total_score": result.total_score,
                "confidence_tier": result.confidence_tier,
                "tier_label": result.tier_label,
                "data_confidence": result.data_confidence,
                "primary_signal": result.primary_signal or None,
                "supporting_signals": result.supporting_signals or None,
                "signals_count": result.signals_count,
                "signals_fired": result.signals_fired or None,
                "data_gaps": result.data_gaps or None,
                "aec_professional_confirmed": result.aec_professional_confirmed,
                "recommended_action": result.recommended_action,
                "scoring_version": result.scoring_version,
            }
            ins = sb.table("subscriber_scores").insert(score_record).execute()
            score_id = ins.data[0]["id"] if ins.data else None
            scored += 1

            sb.table("subscribers").update({"last_scored_at": datetime.now(timezone.utc).isoformat()}).eq("id", sub["id"]).execute()

            if result.confidence_tier in (1, 2) and score_id:
                existing = sb.table("cases").select("id").eq("subscriber_id", sub["id"]).in_("status", ["pending_review", "in_review"]).execute()
                if not existing.data:
                    sb.table("cases").insert({
                        "tenant_id": tenant_id,
                        "subscriber_id": sub["id"],
                        "score_id": score_id,
                        "status": "pending_review",
                    }).execute()
                    cases_created += 1
        except Exception as e:
            log.warning("Failed to score subscriber %s: %s", sub.get("id"), e)

    return OkResponse(data={"scored": scored, "cases_created": cases_created})
