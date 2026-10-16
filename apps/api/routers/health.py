import os
from fastapi import APIRouter
from models.base import OkResponse

router = APIRouter(tags=["health"])


@router.get("/health", response_model=OkResponse)
async def health() -> OkResponse:
    return OkResponse(data={"status": "ok", "env": os.getenv("LYCERT_ENV", "unknown")})
