"""ZeroBounce Stage 0 decision-table tests — Part 1.1. Pure logic, no API calls."""

from services.enrichment.providers.zerobounce_client import _interpret


def test_valid_proceeds():
    r = _interpret({"status": "valid", "free_email": True, "domain": "gmail.com"})
    assert r.status == "valid" and r.blocks_enrichment is False
    assert r.free_email is True


def test_catch_all_proceeds_and_normalises():
    r = _interpret({"status": "catch-all"})
    assert r.status == "catch_all" and r.blocks_enrichment is False


def test_invalid_blocks():
    r = _interpret({"status": "invalid"})
    assert r.status == "invalid" and r.blocks_enrichment is True


def test_disposable_substatus_blocks_and_flags_domain_type():
    r = _interpret({"status": "do_not_mail", "sub_status": "disposable"})
    assert r.status == "disposable" and r.blocks_enrichment is True
    assert r.email_domain_type_override == "disposable"


def test_unknown_proceeds():
    r = _interpret({"status": "unknown"})
    assert r.status == "unknown" and r.blocks_enrichment is False


def test_did_you_mean_surfaced_not_blocking():
    r = _interpret({"status": "valid", "did_you_mean": "gmail.com"})
    assert r.did_you_mean == "gmail.com" and r.blocks_enrichment is False


def test_unlisted_status_proceeds_verbatim():
    # spamtrap/abuse are not in the gate table → proceed, stored verbatim (Part 1.1).
    r = _interpret({"status": "spamtrap"})
    assert r.status == "spamtrap" and r.blocks_enrichment is False
