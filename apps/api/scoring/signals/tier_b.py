"""Tier B signals — user-submitted data (medium weight, easier to fake)."""
from __future__ import annotations
from scoring.models import (
    ScoringConfig, SubscriberRecord,
    PERSONAL_DOMAINS, ACADEMIC_INDICATORS, COUNTRY_ALIASES,
)

Signal = tuple[int, str, str]


def score_b1(record: SubscriberRecord, config: ScoringConfig) -> Signal:
    """B1 — Email Domain classification."""
    email = record.email.strip().lower()
    if not email or "@" not in email:
        return 0, "", ""

    domain = email.split("@")[-1]
    if domain in PERSONAL_DOMAINS:
        return config.signal_b1_personal_weight, "B1_personal_email", \
               f"Uses personal email domain ({domain})"
    for indicator in ACADEMIC_INDICATORS:
        if indicator in domain:
            return config.signal_b1_academic_exculpatory, "B1_academic_email_exculpatory", \
                   f"Email domain suggests academic affiliation ({domain})"
    return 0, "", ""


def score_b2(record: SubscriberRecord, config: ScoringConfig) -> Signal:
    """B2 — Institution Name Quality (highest matching sub-rule only)."""
    inst = record.institution_name.strip()
    account = record.account_name.strip()
    w = config.signal_b2_weight  # max weight (default 20)

    if not inst:
        pts = round(w * 15 / 20)
        return pts, "B2_institution_missing", "Institution name is blank or missing"
    if account and inst.lower() == account.lower():
        return w, "B2_institution_equals_account", \
               "Institution name is identical to account name"
    if len(inst) < 4:
        pts = round(w * 15 / 20)
        return pts, "B2_institution_too_short", \
               f"Institution name is suspiciously short ('{inst}')"
    return 0, "", ""


def _normalize_country(name: str) -> str:
    s = name.strip().lower()
    return COUNTRY_ALIASES.get(s, s)


def score_b3(record: SubscriberRecord, config: ScoringConfig) -> Signal:
    """B3 — Country Mismatch between institution location and account location.

    Country source: prefer the PDL Location-Cleaner normalised field when present (more robust
    than a fixed alias list — e.g. resolves 'Deutschland' → Germany); otherwise fall back to the
    raw location's trailing segment + COUNTRY_ALIASES (the original CEDS behaviour).
    """
    def extract_country(loc: str) -> str:
        parts = [p.strip() for p in loc.split(",")]
        return _normalize_country(parts[-1]) if parts else ""

    def country_of(normalized: str, raw_loc: str) -> str:
        n = (normalized or "").strip()
        if n:
            return _normalize_country(n)
        raw = raw_loc.strip()
        return extract_country(raw) if raw else ""

    c_inst = country_of(record.institution_country_normalized, record.institution_location)
    c_account = country_of(record.account_country_normalized, record.account_country)
    if not c_inst or not c_account:
        return 0, "", ""
    if c_inst != c_account:
        return config.signal_b3_weight, "B3_country_mismatch", \
               f"Institution country ({c_inst.title()}) differs from account country ({c_account.title()})"
    return 0, "", ""
