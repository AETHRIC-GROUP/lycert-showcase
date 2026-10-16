"""load_cascade tests — the spine of the waterfall (Part 4.2). Fixtures only.

Covers: global default order by position, tenant override replacing position+enable,
disabled providers dropped, validation-type excluded, unknown keys ignored, empty on error.
"""

from services.enrichment import orchestrator
from tests.enrichment._fakes import FakeDB

TENANT = "00000000-0000-0000-0000-000000000001"


def _seed_default(db: FakeDB):
    db.provider_rows = [
        {"provider_key": "zerobounce", "provider_type": "validation", "execution_mode": "sync",
         "enabled": True, "default_position": None},
        {"provider_key": "hunter", "provider_type": "enrichment", "execution_mode": "sync",
         "enabled": True, "default_position": 1},
        {"provider_key": "reversecontact", "provider_type": "enrichment", "execution_mode": "sync",
         "enabled": True, "default_position": 2},
        {"provider_key": "datagma", "provider_type": "enrichment", "execution_mode": "sync",
         "enabled": True, "default_position": 3},
        {"provider_key": "pdl", "provider_type": "enrichment", "execution_mode": "sync",
         "enabled": True, "default_position": 4},
        {"provider_key": "fullenrich", "provider_type": "enrichment", "execution_mode": "async",
         "enabled": True, "default_position": 5},
        {"provider_key": "apollo", "provider_type": "enrichment", "execution_mode": "sync",
         "enabled": False, "default_position": 6},
    ]


def test_default_order_excludes_validation_and_disabled():
    db = FakeDB()
    _seed_default(db)
    cascade = orchestrator.load_cascade(db, TENANT)
    keys = [c["provider_key"] for c in cascade]
    assert keys == ["hunter", "reversecontact", "datagma", "pdl", "fullenrich"]
    # zerobounce (validation) and apollo (disabled) excluded.
    assert "zerobounce" not in keys and "apollo" not in keys


def test_async_execution_mode_preserved():
    db = FakeDB()
    _seed_default(db)
    cascade = orchestrator.load_cascade(db, TENANT)
    fe = next(c for c in cascade if c["provider_key"] == "fullenrich")
    assert fe["execution_mode"] == "async"


def test_tenant_override_reorders_and_disables():
    db = FakeDB()
    _seed_default(db)
    # Tenant puts datagma first, hunter second, and disables pdl.
    db.waterfall_rows = [
        {"provider_key": "datagma", "position": 1, "enabled": True},
        {"provider_key": "hunter", "position": 2, "enabled": True},
        {"provider_key": "pdl", "position": 4, "enabled": False},
    ]
    cascade = orchestrator.load_cascade(db, TENANT)
    keys = [c["provider_key"] for c in cascade]
    # datagma + hunter take overridden positions; reversecontact/fullenrich keep defaults;
    # pdl disabled by the tenant → dropped.
    assert keys[0] == "datagma"
    assert keys[1] == "hunter"
    assert "pdl" not in keys
    assert "reversecontact" in keys and "fullenrich" in keys


def test_unknown_provider_key_ignored():
    db = FakeDB()
    db.provider_rows = [
        {"provider_key": "hunter", "provider_type": "enrichment", "execution_mode": "sync",
         "enabled": True, "default_position": 1},
        {"provider_key": "ghostprovider", "provider_type": "enrichment", "execution_mode": "sync",
         "enabled": True, "default_position": 2},
    ]
    cascade = orchestrator.load_cascade(db, TENANT)
    assert [c["provider_key"] for c in cascade] == ["hunter"]  # not in PROVIDER_REGISTRY → dropped


def test_null_position_provider_dropped():
    db = FakeDB()
    db.provider_rows = [
        {"provider_key": "hunter", "provider_type": "enrichment", "execution_mode": "sync",
         "enabled": True, "default_position": None},  # no position and no override → cannot order
    ]
    assert orchestrator.load_cascade(db, TENANT) == []
