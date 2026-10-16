import os
import logging
import httpx
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import JWTError, jwt, jwk
from models.base import TenantContext

logger = logging.getLogger(__name__)
_bearer = HTTPBearer()
_jwks_cache: list | None = None


async def _get_jwks() -> list:
    """Fetch and cache JWKS keys from Supabase. Async to avoid blocking the event loop."""
    global _jwks_cache
    if _jwks_cache is None:
        url = os.getenv("LYCERT_SUPABASE_URL", "")
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{url}/auth/v1/.well-known/jwks.json")
        resp.raise_for_status()
        _jwks_cache = resp.json().get("keys", [])
    return _jwks_cache


async def _decode_token(token: str) -> dict:
    """Decode and verify a Supabase JWT.

    Supabase projects may use HS256 (legacy shared secret) or ES256 (ECC P-256, current default).
    The JWT header 'alg' field determines which path to take:
    - HS256: verified with LYCERT_SUPABASE_JWT_SECRET (legacy secret or test secret)
    - ES256/RS256: verified with the project's public key fetched from the JWKS endpoint
    """
    try:
        header = jwt.get_unverified_header(token)
    except JWTError as exc:
        raise JWTError(f"Malformed token header: {exc}")

    alg = header.get("alg", "HS256")
    kid = header.get("kid")

    if alg == "HS256":
        secret = os.getenv("LYCERT_SUPABASE_JWT_SECRET", "")
        if not secret:
            raise JWTError("LYCERT_SUPABASE_JWT_SECRET not set")
        return jwt.decode(token, secret, algorithms=["HS256"], options={"verify_aud": False})

    # ES256 or RS256 — verify using JWKS public keys
    keys = await _get_jwks()
    for key_data in keys:
        if kid and key_data.get("kid") != kid:
            continue
        try:
            public_key = jwk.construct(key_data)
            return jwt.decode(token, public_key, algorithms=[alg], options={"verify_aud": False})
        except JWTError:
            continue

    # If kid matched nothing, try all keys (handles edge cases during key rotation)
    for key_data in keys:
        try:
            public_key = jwk.construct(key_data)
            return jwt.decode(token, public_key, algorithms=[alg], options={"verify_aud": False})
        except JWTError:
            continue

    raise JWTError(f"No valid JWKS key found for kid={kid}, alg={alg}")


async def require_auth(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer),
) -> TenantContext:
    """FastAPI dependency. Validates Supabase JWT and extracts tenant_id + role.
    Handles both HS256 (legacy/test) and ES256 (current Supabase ECC P-256 signing).
    Inject into any route that requires authentication.
    """
    token = credentials.credentials
    try:
        payload = await _decode_token(token)
    except JWTError as exc:
        logger.warning("JWT validation failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "invalid_token", "message": "Invalid or expired token"},
        )

    tenant_id = payload.get("tenant_id")
    # Supabase JWTs carry 'role' = 'authenticated' (PostgREST DB role, never changed).
    # Our custom_access_token_hook injects the app-level role as 'user_role' to avoid
    # overwriting the DB role that PostgREST depends on.
    role = payload.get("user_role")
    user_id = payload.get("sub")

    if not tenant_id or not role or not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "missing_claims", "message": "Token is missing required claims"},
        )

    return TenantContext(tenant_id=tenant_id, role=role, user_id=user_id)
