"""FullEnrich webhook tests — Part 4.3. Fixtures only, no network.

Covers: valid signature, invalid signature → 401, idempotent replay, 24h timeout cleanup.
"""

import hashlib
import hmac
import json
from datetime import datetime, timezone, timedelta

from fastapi.testclient import TestClient

from services.enrichment import async_webhook
from services.enrichment.providers import fullenrich_client
from tests.enrichment._fakes import FakeDB

_KEY = "test-fullenrich-key"
TENANT = "00000000-0000-0000-0000-000000000001"


def _sign(body: bytes) -> str:
    return hmac.new(_KEY.encode(), body, hashlib.sha1).hexdigest()


# ── signature verification ─────────────────────────────────────────────────────

def test_verify_signature_valid(monkeypatch):
    monkeypatch.setenv("LYCERT_FULLENRICH_API_KEY", _KEY)
    body = b'{"id":"enr-1"}'
    assert fullenrich_client.verify_signature(body, _sign(body)) is True


def test_verify_signature_accepts_sha1_prefix(monkeypatch):
    monkeypatch.setenv("LYCERT_FULLENRICH_API_KEY", _KEY)
    body = b'{"id":"enr-1"}'
    assert fullenrich_client.verify_signature(body, "sha1=" + _sign(body)) is True


def test_verify_signature_invalid(monkeypatch):
    monkeypatch.setenv("LYCERT_FULLENRICH_API_KEY", _KEY)
    assert fullenrich_client.verify_signature(b'{"id":"enr-1"}', "deadbeef") is False
    assert fullenrich_client.verify_signature(b'{"id":"enr-1"}', None) is False


# ── webhook route ───────────────────────────────────────────────────────────────

def test_webhook_route_rejects_invalid_signature(monkeypatch):
    monkeypatch.setenv("LYCERT_FULLENRICH_API_KEY", _KEY)
    from main import app
    client = TestClient(app)
    resp = client.post(
        "/api/v1/enrichment/webhook/fullenrich",
        content=b'{"id":"enr-1","data":[]}',
        headers={"X-FullEnrich-Signature": "wrong"},
    )
    assert resp.status_code == 401


def test_webhook_route_accepts_valid_signature_and_schedules_processing(monkeypatch):
    monkeypatch.setenv("LYCERT_FULLENRICH_API_KEY", _KEY)
    seen = {}
    import routers.enrich as enrich_router
    monkeypatch.setattr(enrich_router, "process_results",
                        lambda payload, eid: seen.update({"payload": payload, "eid": eid}))

    from main import app
    client = TestClient(app)
    body = json.dumps({"id": "enr-1", "data": [{"custom": {"lycert_subscriber_id": "sub-1"}}]}).encode()
    resp = client.post(
        "/api/v1/enrichment/webhook/fullenrich",
        content=body,
        headers={"X-FullEnrich-Signature": _sign(body)},
    )
    assert resp.status_code == 200
    assert seen["eid"] == "enr-1"


# ── idempotent processing ───────────────────────────────────────────────────────

def _pending_row():
    return {
        "subscriber_id": "sub-1",
        "tenant_id": TENANT,
        "field_provenance": {"li_job_title": "hunter"},
        "li_job_title": "Architect",
        "providers_attempted": [{"provider": "hunter", "outcome": "partial"},
                                {"provider": "fullenrich", "outcome": "pending"}],
        "completeness": "partial",
        "pending_async_provider": "fullenrich",
    }


def _payload():
    return {
        "id": "enr-1",
        "status": "FINISHED",
        "data": [{
            "custom": {"lycert_subscriber_id": "sub-1", "lycert_job_id": "job-1"},
            "contact": {"linkedin_url": "https://linkedin.com/in/jane",
                        "company_name": "Gensler", "company_domain": "gensler.com"},
        }],
    }


def test_process_results_merges_and_clears_pending(monkeypatch):
    db = FakeDB()
    db.enrichment_rows["sub-1"] = _pending_row()
    db.subscriber_rows["sub-1"] = {"name": "Jane Smith"}
    monkeypatch.setattr(async_webhook, "_db", lambda: db)

    out = async_webhook.process_results(_payload())
    assert out["processed"] == 1 and out["matched"] == 1
    row = db.enrichment_rows["sub-1"]
    assert row["pending_async_provider"] is None
    assert row["li_current_employer_name"] == "Gensler"      # gap-filled by FullEnrich
    assert row["li_job_title"] == "Architect"                # first-wins preserved (hunter)
    assert {"provider": "fullenrich", "outcome": "partial"} in row["providers_attempted"]


def test_process_results_idempotent_replay(monkeypatch):
    db = FakeDB()
    db.enrichment_rows["sub-1"] = _pending_row()
    db.subscriber_rows["sub-1"] = {"name": "Jane Smith"}
    monkeypatch.setattr(async_webhook, "_db", lambda: db)

    first = async_webhook.process_results(_payload())
    second = async_webhook.process_results(_payload())   # retry / duplicate delivery
    assert first["processed"] == 1
    assert second["processed"] == 0 and second["skipped"] == 1


# ── 24h timeout cleanup ──────────────────────────────────────────────────────────

def test_cleanup_stale_pending_clears_old_rows(monkeypatch):
    db = FakeDB()
    old = (datetime.now(timezone.utc) - timedelta(hours=30)).isoformat()
    db.enrichment_rows["sub-1"] = {**_pending_row(), "enriched_at": old}
    db.stale_pending = [{
        "subscriber_id": "sub-1",
        "providers_attempted": [{"provider": "fullenrich", "outcome": "pending"}],
        "enriched_at": old,
    }]
    monkeypatch.setattr(async_webhook, "_db", lambda: db)

    out = async_webhook.cleanup_stale_pending(older_than_hours=24)
    assert out["cleared"] == 1
    row = db.enrichment_rows["sub-1"]
    assert row["pending_async_provider"] is None
    assert {"provider": "fullenrich", "outcome": "miss"} in row["providers_attempted"]
