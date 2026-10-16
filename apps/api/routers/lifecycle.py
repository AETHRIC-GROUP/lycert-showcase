"""Lifecycle stage router.

Two endpoints:
- POST /api/v1/lifecycle/run           — cron trigger (X-Cron-Secret header)
- POST /api/v1/lifecycle/run/{tenant_id} — manual trigger for one tenant (JWT auth, owner/admin only)
"""

import logging
import os

from fastapi import APIRouter, Depends, Header, HTTPException, status

from middleware.auth import require_auth
from models.base import OkResponse, TenantContext
from services.lifecycle import run_lifecycle_job

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/lifecycle", tags=["lifecycle"])

_ALLOWED_MANUAL_ROLES = {"owner", "admin"}


def _require_cron_secret(x_cron_secret: str | None = Header(default=None)) -> None:
    expected = os.getenv("LYCERT_CRON_SECRET")
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "config_error", "message": "LYCERT_CRON_SECRET not set"},
        )
    if x_cron_secret != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "invalid_cron_secret", "message": "Invalid or missing X-Cron-Secret header"},
        )


@router.post("/run", response_model=OkResponse)
async def run_all_tenants(
    _: None = Depends(_require_cron_secret),
) -> OkResponse:
    """Nightly cron endpoint — evaluates lifecycle stages for all tenants.

    Called by Railway cron at 02:00 UTC. Protected by X-Cron-Secret header.
    """
    logger.info("lifecycle_job: starting full run (all tenants)")
    result = run_lifecycle_job()
    logger.info("lifecycle_job: complete evaluated=%d updated=%d", result["evaluated"], result["updated"])
    return OkResponse(data=result)


@router.post("/run/{tenant_id}", response_model=OkResponse)
async def run_single_tenant(
    tenant_id: str,
    ctx: TenantContext = Depends(require_auth),
) -> OkResponse:
    """Manual trigger for a single tenant. Owner/admin only.

    Useful for testing or re-running after a data correction.
    The requesting user must belong to the specified tenant.
    """
    if ctx.role not in _ALLOWED_MANUAL_ROLES:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "forbidden", "message": "Owner or admin role required"},
        )
    if ctx.tenant_id != tenant_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "forbidden", "message": "You can only run lifecycle for your own tenant"},
        )

    logger.info("lifecycle_job: manual run tenant=%s user=%s", tenant_id, ctx.user_id)
    result = run_lifecycle_job(tenant_id=tenant_id)
    return OkResponse(data=result)
