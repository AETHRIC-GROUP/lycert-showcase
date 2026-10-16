import os
import pytest
from fastapi.testclient import TestClient
from jose import jwt

os.environ.setdefault("LYCERT_ENV", "test")
os.environ.setdefault("LYCERT_SUPABASE_JWT_SECRET", "test-secret-at-least-32-chars-long!!")
os.environ.setdefault("LYCERT_SUPABASE_URL", "https://test.supabase.co")
os.environ.setdefault("LYCERT_SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key")

from main import app  # noqa: E402 — must import after env vars are set


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def make_jwt(tenant_id: str = "00000000-0000-0000-0000-000000000001", role: str = "manager") -> str:
    """Generate a signed test JWT matching the real Supabase token shape.
    'role' stays 'authenticated' (PostgREST DB role). App role goes in 'user_role'."""
    payload = {
        "sub": "00000000-0000-0000-0000-000000000099",
        "tenant_id": tenant_id,
        "role": "authenticated",
        "user_role": role,
        "aud": "authenticated",
    }
    return jwt.encode(payload, os.environ["LYCERT_SUPABASE_JWT_SECRET"], algorithm="HS256")


@pytest.fixture
def auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {make_jwt()}"}
