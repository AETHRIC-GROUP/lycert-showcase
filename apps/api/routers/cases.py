from fastapi import APIRouter, Depends
from middleware.auth import require_auth
from models.base import OkResponse, TenantContext

router = APIRouter(prefix="/cases", tags=["cases"])


@router.get("", response_model=OkResponse)
async def list_cases(ctx: TenantContext = Depends(require_auth)) -> OkResponse:
    # Phase 1 Step 7 — full implementation
    return OkResponse(data=[])


@router.get("/{case_id}", response_model=OkResponse)
async def get_case(case_id: str, ctx: TenantContext = Depends(require_auth)) -> OkResponse:
    # Phase 1 Step 7 — full implementation
    return OkResponse(data=None)
