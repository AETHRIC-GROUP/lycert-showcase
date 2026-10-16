from fastapi import APIRouter, Depends
from middleware.auth import require_auth
from models.base import OkResponse, TenantContext

router = APIRouter(prefix="/auth", tags=["auth"])


@router.get("/me", response_model=OkResponse)
async def me(ctx: TenantContext = Depends(require_auth)) -> OkResponse:
    """Returns the current authenticated tenant context. Useful for verifying JWT claims."""
    return OkResponse(data={"tenant_id": ctx.tenant_id, "role": ctx.role, "user_id": ctx.user_id})
