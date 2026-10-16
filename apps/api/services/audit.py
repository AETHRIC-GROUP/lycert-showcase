import os
import logging
from typing import Any
from supabase import create_client, Client

logger = logging.getLogger(__name__)


def _service_client() -> Client:
    url = os.getenv("LYCERT_SUPABASE_URL")
    key = os.getenv("LYCERT_SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise RuntimeError("LYCERT_SUPABASE_URL and LYCERT_SUPABASE_SERVICE_ROLE_KEY must be set")
    return create_client(url, key)


async def log_action(
    tenant_id: str,
    action: str,
    resource_type: str,
    actor_id: str | None = None,
    actor_type: str = "user",
    resource_id: str | None = None,
    metadata: dict[str, Any] | None = None,
    ip_address: str | None = None,
) -> None:
    """Write one row to audit_logs. Called after every write operation. Never skipped."""
    try:
        _service_client().table("audit_logs").insert({
            "tenant_id": tenant_id,
            "actor_id": actor_id,
            "actor_type": actor_type,
            "action": action,
            "resource_type": resource_type,
            "resource_id": resource_id,
            "metadata": metadata,
            "ip_address": ip_address,
        }).execute()
    except Exception:
        logger.exception("Failed to write audit log: action=%s tenant=%s", action, tenant_id)
        raise
