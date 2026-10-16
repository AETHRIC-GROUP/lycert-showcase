from pydantic import BaseModel
from typing import Any


class OkResponse(BaseModel):
    data: Any = None
    error: None = None


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    data: None = None
    error: ErrorDetail


class TenantContext(BaseModel):
    tenant_id: str
    role: str
    user_id: str
