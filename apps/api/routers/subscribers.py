from fastapi import APIRouter, Depends
from middleware.auth import require_auth
from models.base import OkResponse, TenantContext

router = APIRouter(prefix="/subscribers", tags=["subscribers"])


@router.get("", response_model=OkResponse)
async def list_subscribers(ctx: TenantContext = Depends(require_auth)) -> OkResponse:
    # Phase 1 Step 6 — full implementation
    return OkResponse(data=[])


@router.get("/{subscriber_id}", response_model=OkResponse)
async def get_subscriber(subscriber_id: str, ctx: TenantContext = Depends(require_auth)) -> OkResponse:
    # Phase 1 Step 6 — full implementation
    return OkResponse(data=None)
