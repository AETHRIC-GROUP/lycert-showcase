"""Tests for lifecycle router endpoints."""

import os
import pytest
from unittest.mock import patch, MagicMock
from jose import jwt

CRON_SECRET = "test-cron-secret-value"


def make_tenant_jwt(role: str = "owner") -> str:
    payload = {
        "sub": "00000000-0000-0000-0000-000000000099",
        "tenant_id": "00000000-0000-0000-0000-000000000001",
        "role": "authenticated",
        "user_role": role,
        "aud": "authenticated",
    }
    return jwt.encode(payload, os.environ["LYCERT_SUPABASE_JWT_SECRET"], algorithm="HS256")


# ── Cron endpoint ──────────────────────────────────────────────────────────

def test_cron_run_requires_secret(client) -> None:
    with patch.dict(os.environ, {"LYCERT_CRON_SECRET": CRON_SECRET}):
        response = client.post("/api/v1/lifecycle/run")
        assert response.status_code == 401


def test_cron_run_wrong_secret_rejected(client) -> None:
    with patch.dict(os.environ, {"LYCERT_CRON_SECRET": CRON_SECRET}):
        response = client.post("/api/v1/lifecycle/run", headers={"X-Cron-Secret": "wrong"})
        assert response.status_code == 401


def test_cron_run_correct_secret_calls_job(client) -> None:
    mock_result = {"job_date": "2026-06-06", "evaluated": 10, "updated": 3, "tenants": []}
    with patch.dict(os.environ, {"LYCERT_CRON_SECRET": CRON_SECRET}):
        with patch("routers.lifecycle.run_lifecycle_job", return_value=mock_result) as mock_job:
            response = client.post("/api/v1/lifecycle/run", headers={"X-Cron-Secret": CRON_SECRET})
            assert response.status_code == 200
            assert response.json()["data"]["updated"] == 3
            mock_job.assert_called_once_with()


# ── Manual single-tenant endpoint ─────────────────────────────────────────

def test_manual_run_requires_jwt(client) -> None:
    response = client.post("/api/v1/lifecycle/run/00000000-0000-0000-0000-000000000001")
    assert response.status_code == 401


def test_manual_run_viewer_role_forbidden(client) -> None:
    token = make_tenant_jwt(role="viewer")
    response = client.post(
        "/api/v1/lifecycle/run/00000000-0000-0000-0000-000000000001",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 403


def test_manual_run_wrong_tenant_forbidden(client) -> None:
    token = make_tenant_jwt(role="owner")
    response = client.post(
        "/api/v1/lifecycle/run/99999999-9999-9999-9999-999999999999",  # different tenant
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 403


def test_manual_run_owner_correct_tenant_succeeds(client) -> None:
    token = make_tenant_jwt(role="owner")
    mock_result = {"job_date": "2026-06-06", "evaluated": 5, "updated": 1, "tenants": []}
    with patch("routers.lifecycle.run_lifecycle_job", return_value=mock_result) as mock_job:
        response = client.post(
            "/api/v1/lifecycle/run/00000000-0000-0000-0000-000000000001",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200
        mock_job.assert_called_once_with(tenant_id="00000000-0000-0000-0000-000000000001")
