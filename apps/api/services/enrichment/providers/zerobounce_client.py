"""ZeroBounce — Stage 0 email validation gate.

LYCERT_WATERFALL_ENRICHMENT_V2.md Part 1.1. Runs BEFORE any paid lookup so the waterfall
never spends a credit on a dead or disposable address. Results are cached 180 days
(cache check lives in the orchestrator, which owns the DB).

Auth: api_key as a query parameter (ZeroBounce's documented method).
ip_address is a required param — always sent as an empty string.
"""

import logging
import os
from dataclasses import dataclass
from typing import Any

import httpx

logger = logging.getLogger(__name__)

_BASE = "https://api.zerobounce.net/v2"
_TIMEOUT = 10.0
_TIMEOUT_BATCH = 30.0
_BATCH_MAX = 200
_COST_PER_VALIDATION = 0.006

# Normalised statuses we persist to subscribers.email_validation_status.
_STATUS_VALID = "valid"
_STATUS_INVALID = "invalid"
_STATUS_CATCH_ALL = "catch_all"
_STATUS_UNKNOWN = "unknown"
_STATUS_DISPOSABLE = "disposable"


@dataclass
class ValidationResult:
    raw_status: str                       # ZeroBounce's status verbatim
    status: str                           # normalised for subscribers.email_validation_status
    sub_status: str
    free_email: bool
    did_you_mean: str | None
    blocks_enrichment: bool               # True → skip the entire waterfall
    email_domain_type_override: str | None  # 'disposable' when sub_status indicates disposable
    cost_usd: float = _COST_PER_VALIDATION


def _interpret(item: dict[str, Any]) -> ValidationResult:
    """Apply the Part 1.1 decision table to one ZeroBounce result item."""
    raw = (item.get("status") or "").strip().lower()
    sub = (item.get("sub_status") or "").strip().lower()
    did_you_mean = item.get("did_you_mean") or None
    free_email = bool(item.get("free_email"))

    # sub_status disposable takes precedence — STOP, and the disposable flag is itself a B1 signal.
    if sub == "disposable":
        return ValidationResult(
            raw_status=raw, status=_STATUS_DISPOSABLE, sub_status=sub, free_email=free_email,
            did_you_mean=did_you_mean, blocks_enrichment=True,
            email_domain_type_override="disposable",
        )

    if raw == "invalid":
        return ValidationResult(
            raw_status=raw, status=_STATUS_INVALID, sub_status=sub, free_email=free_email,
            did_you_mean=did_you_mean, blocks_enrichment=True, email_domain_type_override=None,
        )

    if raw == "catch-all":
        norm = _STATUS_CATCH_ALL
    elif raw == "valid":
        norm = _STATUS_VALID
    elif raw == "unknown":
        norm = _STATUS_UNKNOWN
    else:
        # spamtrap / abuse / do_not_mail / anything else — store verbatim, proceed
        # (the Part 1.1 table only gates on invalid + disposable).
        norm = raw or _STATUS_UNKNOWN

    return ValidationResult(
        raw_status=raw, status=norm, sub_status=sub, free_email=free_email,
        did_you_mean=did_you_mean, blocks_enrichment=False, email_domain_type_override=None,
    )


class ZeroBounceClient:
    provider_key = "zerobounce"
    execution_mode = "sync"

    @staticmethod
    def _api_key() -> str:
        key = os.environ.get("LYCERT_ZEROBOUNCE_API_KEY", "")
        if not key:
            raise RuntimeError("LYCERT_ZEROBOUNCE_API_KEY env var not set")
        return key

    async def validate(self, email: str) -> ValidationResult:
        """Validate one email. Raises on no API key; returns a permissive 'unknown'
        (proceed) on transport error so a ZeroBounce outage never blocks coverage."""
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                resp = await client.get(
                    f"{_BASE}/validate",
                    params={"api_key": self._api_key(), "email": email, "ip_address": ""},
                )
            resp.raise_for_status()
            return _interpret(resp.json())
        except RuntimeError:
            raise
        except Exception:
            logger.exception("zerobounce validate error email=%s", email)
            return ValidationResult(
                raw_status="error", status=_STATUS_UNKNOWN, sub_status="", free_email=False,
                did_you_mean=None, blocks_enrichment=False, email_domain_type_override=None,
                cost_usd=0.0,
            )

    async def validate_batch(self, emails: list[str]) -> dict[str, ValidationResult]:
        """Validate up to 200 emails in one call. Returns {email: ValidationResult}."""
        if not emails:
            return {}
        if len(emails) > _BATCH_MAX:
            raise ValueError(f"ZeroBounce batch accepts max {_BATCH_MAX} emails per request")
        body = {
            "api_key": self._api_key(),
            "email_batch": [{"email_address": e, "ip_address": ""} for e in emails],
        }
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT_BATCH) as client:
                resp = await client.post(f"{_BASE}/validatebatch", json=body)
            resp.raise_for_status()
            data = resp.json()
        except Exception:
            logger.exception("zerobounce validate_batch error count=%d", len(emails))
            # Permissive: treat all as unknown/proceed on outage.
            return {
                e: ValidationResult("error", _STATUS_UNKNOWN, "", False, None, False, None, 0.0)
                for e in emails
            }

        out: dict[str, ValidationResult] = {}
        for item in data.get("email_batch") or []:
            addr = item.get("address") or item.get("email_address")
            if addr:
                out[addr] = _interpret(item)
        # Any email ZeroBounce didn't return → unknown/proceed.
        for e in emails:
            out.setdefault(e, ValidationResult("error", _STATUS_UNKNOWN, "", False, None, False, None, 0.0))
        return out
