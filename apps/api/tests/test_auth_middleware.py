import os
import pytest
from jose import jwt


def test_protected_route_without_token_returns_401(client) -> None:
    response = client.get("/api/v1/auth/me")
    assert response.status_code == 401


def test_protected_route_with_invalid_token_returns_401(client) -> None:
    response = client.get("/api/v1/auth/me", headers={"Authorization": "Bearer invalid.token.here"})
    assert response.status_code == 401


def test_protected_route_with_valid_token_returns_200(client, auth_headers) -> None:
    response = client.get("/api/v1/auth/me", headers=auth_headers)
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["tenant_id"] == "00000000-0000-0000-0000-000000000001"
    assert data["role"] == "manager"


def test_token_missing_tenant_id_returns_401(client) -> None:
    # Has user_role but no tenant_id — should 401
    payload = {"sub": "some-user", "role": "authenticated", "user_role": "manager", "aud": "authenticated"}
    token = jwt.encode(payload, os.environ["LYCERT_SUPABASE_JWT_SECRET"], algorithm="HS256")
    response = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401


def test_token_missing_user_role_returns_401(client) -> None:
    # Has tenant_id but no user_role — should 401 (hook didn't fire / user not in tenant_users)
    payload = {"sub": "some-user", "tenant_id": "some-tenant", "role": "authenticated", "aud": "authenticated"}
    token = jwt.encode(payload, os.environ["LYCERT_SUPABASE_JWT_SECRET"], algorithm="HS256")
    response = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401
