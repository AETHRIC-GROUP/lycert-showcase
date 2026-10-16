"""Orchestrator cascade tests — Part 2.3 / Part 4.2. Fixtures only, no network/DB.

Covers: stop-on-COMPLETE, continue-on-PARTIAL, Stage 0 gating, async handoff threshold
(enrichment_priority >= 40), and budget-pause behaviour.
"""

import asyncio
from datetime import date, datetime, timezone

import pytest

from services.enrichment import orchestrator, credit_tracker
from services.enrichment.providers.base import ProviderOutcome, ProviderResult
from tests.enrichment._fakes import FakeDB

TENANT = "00000000-0000-0000-0000-000000000001"


def _fresh_valid_sub(**over):
    sub = {
        "id": "sub-1",
        "email": "jane@gmail.com",
        "name": "Jane Smith",
        "lifecycle_stage": "post_graduation_unverified",
        "enrichment_priority": 50,
        "email_validation_status": "valid",
        "email_validated_at": datetime.now(timezone.utc).isoformat(),
    }
    sub.update(over)
    return sub


def _stub_provider(provider_key, result: ProviderResult, calls: list):
    class _Stub:
        def __init__(self, *a, **k):
            pass
        async def enrich(self, email, name, subscriber_id):
            calls.append(provider_key)
            return result
    return _Stub


_COMPLETE = {
    "linkedin_profile_url": "https://linkedin.com/in/janesmith",
    "li_current_employer_name": "Gensler",
    "li_job_title": "Architect",
    "li_job_start_date": date(2024, 2, 1),
    "li_education_end_date": date(2023, 12, 31),
}
_PARTIAL = {"li_current_employer_name": "Gensler", "li_job_title": "Architect", "linkedin_profile_url": "x"}


def _result(key, outcome, fields):
    return ProviderResult(provider_key=key, outcome=outcome, fields=fields, charged=bool(fields),
                          cost_usd=0.03 if fields else 0.0, full_name="Jane Smith")


def test_stop_on_complete(monkeypatch):
    calls: list = []
    registry = {
        "hunter": _stub_provider("hunter", _result("hunter", ProviderOutcome.PARTIAL, _PARTIAL), calls),
        "reversecontact": _stub_provider("reversecontact", _result("reversecontact", ProviderOutcome.COMPLETE, _COMPLETE), calls),
        "datagma": _stub_provider("datagma", _result("datagma", ProviderOutcome.COMPLETE, _COMPLETE), calls),
    }
    monkeypatch.setattr(orchestrator, "PROVIDER_REGISTRY", registry)
    db = FakeDB()
    cascade = [
        {"provider_key": "hunter", "execution_mode": "sync", "position": 1},
        {"provider_key": "reversecontact", "execution_mode": "sync", "position": 2},
        {"provider_key": "datagma", "execution_mode": "sync", "position": 3},
    ]
    stats: dict = {}
    summary = asyncio.run(orchestrator.run_waterfall(db, _fresh_valid_sub(), TENANT, cascade, stats, "job-1"))

    assert summary["completeness"] == "complete"
    assert calls == ["hunter", "reversecontact"]   # datagma never reached
    row = db.enrichment_rows["sub-1"]
    assert row["completeness"] == "complete"
    assert row["pending_async_provider"] is None


def test_continue_on_partial(monkeypatch):
    calls: list = []
    registry = {
        "hunter": _stub_provider("hunter", _result("hunter", ProviderOutcome.PARTIAL, _PARTIAL), calls),
        "reversecontact": _stub_provider("reversecontact", _result("reversecontact", ProviderOutcome.PARTIAL,
            {"li_employer_industry": "Architecture"}), calls),
    }
    monkeypatch.setattr(orchestrator, "PROVIDER_REGISTRY", registry)
    db = FakeDB()
    cascade = [
        {"provider_key": "hunter", "execution_mode": "sync", "position": 1},
        {"provider_key": "reversecontact", "execution_mode": "sync", "position": 2},
    ]
    summary = asyncio.run(orchestrator.run_waterfall(db, _fresh_valid_sub(), TENANT, cascade, {}, "job-1"))
    assert summary["completeness"] == "partial"
    assert calls == ["hunter", "reversecontact"]   # both ran — partial never stops


def test_stage0_blocks_invalid_email(monkeypatch):
    calls: list = []
    registry = {"hunter": _stub_provider("hunter", _result("hunter", ProviderOutcome.PARTIAL, _PARTIAL), calls)}
    monkeypatch.setattr(orchestrator, "PROVIDER_REGISTRY", registry)
    db = FakeDB()
    cascade = [{"provider_key": "hunter", "execution_mode": "sync", "position": 1}]
    sub = _fresh_valid_sub(email_validation_status="invalid")
    summary = asyncio.run(orchestrator.run_waterfall(db, sub, TENANT, cascade, {}, "job-1"))

    assert summary["blocked"] is True
    assert calls == []   # no paid lookup ever runs on an undeliverable email
    assert db.enrichment_rows["sub-1"]["provider_miss_reason"] == "email_undeliverable"


def test_stage0_blocks_disposable_email(monkeypatch):
    calls: list = []
    monkeypatch.setattr(orchestrator, "PROVIDER_REGISTRY",
                        {"hunter": _stub_provider("hunter", _result("hunter", ProviderOutcome.PARTIAL, _PARTIAL), calls)})
    db = FakeDB()
    cascade = [{"provider_key": "hunter", "execution_mode": "sync", "position": 1}]
    sub = _fresh_valid_sub(email_validation_status="disposable")
    summary = asyncio.run(orchestrator.run_waterfall(db, sub, TENANT, cascade, {}, "job-1"))
    assert summary["blocked"] is True
    assert calls == []


def test_async_handoff_above_priority_threshold(monkeypatch):
    calls: list = []
    monkeypatch.setattr(orchestrator, "PROVIDER_REGISTRY",
                        {"hunter": _stub_provider("hunter", _result("hunter", ProviderOutcome.MISS, {}), calls)})

    submitted: list = []

    class _StubFullEnrich:
        def __init__(self, job_id=None):
            self.job_id = job_id
        async def enrich(self, email, name, subscriber_id):
            submitted.append(subscriber_id)
            return ProviderResult("fullenrich", ProviderOutcome.PENDING, async_reference="enr-123")
    monkeypatch.setattr(orchestrator, "FullEnrichClient", _StubFullEnrich)

    db = FakeDB()
    cascade = [
        {"provider_key": "hunter", "execution_mode": "sync", "position": 1},
        {"provider_key": "fullenrich", "execution_mode": "async", "position": 5},
    ]
    summary = asyncio.run(orchestrator.run_waterfall(db, _fresh_valid_sub(enrichment_priority=50), TENANT, cascade, {}, "job-1"))
    assert summary["pending"] == "fullenrich"
    assert submitted == ["sub-1"]
    assert db.enrichment_rows["sub-1"]["pending_async_provider"] == "fullenrich"


def test_async_handoff_skipped_below_priority_threshold(monkeypatch):
    calls: list = []
    monkeypatch.setattr(orchestrator, "PROVIDER_REGISTRY",
                        {"hunter": _stub_provider("hunter", _result("hunter", ProviderOutcome.MISS, {}), calls)})
    submitted: list = []

    class _StubFullEnrich:
        def __init__(self, job_id=None):
            pass
        async def enrich(self, email, name, subscriber_id):
            submitted.append(subscriber_id)
            return ProviderResult("fullenrich", ProviderOutcome.PENDING, async_reference="enr-123")
    monkeypatch.setattr(orchestrator, "FullEnrichClient", _StubFullEnrich)

    db = FakeDB()
    cascade = [
        {"provider_key": "hunter", "execution_mode": "sync", "position": 1},
        {"provider_key": "fullenrich", "execution_mode": "async", "position": 5},
    ]
    summary = asyncio.run(orchestrator.run_waterfall(db, _fresh_valid_sub(enrichment_priority=30), TENANT, cascade, {}, "job-1"))
    assert summary["pending"] is None
    assert submitted == []   # below 40 → accept the partial/miss, don't pay the sweep


def test_budget_pause_blocks_enrichment(monkeypatch):
    monkeypatch.setenv("LYCERT_PDL_API_KEY", "x")
    db = FakeDB()
    db.subscriber_rows["sub-1"] = _fresh_valid_sub()
    monkeypatch.setattr(orchestrator, "_db", lambda: db)
    monkeypatch.setattr(credit_tracker, "check_budget",
                        lambda _db, _t, requested: {"allowed": False, "reason": "budget_exhausted"})

    result = asyncio.run(orchestrator.enrich_subscriber("sub-1", TENANT))
    assert result["status"] == "budget_exhausted"
