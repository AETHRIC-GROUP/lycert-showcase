"""Multi-provider field merge engine — LYCERT_WATERFALL_ENRICHMENT_V2.md Part 5.

When several providers contribute to one subscriber, their canonical fields are merged under
the Part 5 rules. Implemented once here so the orchestrator and the unit tests share it.

Rules:
  1. First-written wins per field (earlier providers are cheaper) — EXCEPT rule 2.
  2. PDL education override: PDL's li_education_* overwrite any earlier provider's values.
  3. Employment-date completion: earlier employer with no dates + later provider with dates
     for the SAME employer → merge the dates in. DIFFERENT employer → the later provider's
     full employment block replaces the earlier one (real-time providers are fresher).
  4. Never merge across people: if a later provider's full_name has zero token overlap with
     the subscriber's name, discard that provider's result entirely (provider_mismatch).
  5. Every written field records its provider in field_provenance.
  6. GDPR exclusions are enforced at the mapper level (strip_to_canonical) for every provider.
"""

import logging
import re

logger = logging.getLogger(__name__)

EMPLOYMENT_FIELDS: frozenset[str] = frozenset({
    "li_current_employer_name",
    "li_current_employer_domain",
    "li_current_employer_linkedin_url",
    "li_employer_size",
    "li_employer_industry",
    "li_job_title",
    "li_job_title_levels",
    "li_job_start_date",
    "li_job_end_date",
})

EDUCATION_FIELDS: frozenset[str] = frozenset({
    "li_education_institution",
    "li_education_end_date",
})

# Legal suffixes stripped before comparing employer names (Part 5 rule 3).
_LEGAL_SUFFIXES = {
    "gmbh", "inc", "incorporated", "ltd", "limited", "llc", "co", "corp", "corporation",
    "ag", "sa", "sas", "sarl", "bv", "plc", "kg", "kgaa", "ug", "oy", "ab", "as", "spa", "srl",
}
_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _name_tokens(name: str | None) -> set[str]:
    if not name:
        return set()
    return {t for t in _TOKEN_RE.findall(name.lower()) if len(t) >= 2}


def names_overlap(subscriber_name: str | None, provider_full_name: str | None) -> bool:
    """Part 5 rule 4 guard. True if the names share at least one token (or we lack data to
    judge — absence of a name is never treated as a mismatch, to avoid discarding good data)."""
    if not subscriber_name or not provider_full_name:
        return True
    a, b = _name_tokens(subscriber_name), _name_tokens(provider_full_name)
    if not a or not b:
        return True
    return bool(a & b)


def _normalize_employer(name: str | None) -> str:
    if not name:
        return ""
    tokens = [t for t in _TOKEN_RE.findall(name.lower()) if t not in _LEGAL_SUFFIXES]
    return " ".join(tokens).strip()


def same_employer(a: str | None, b: str | None) -> bool:
    """Case-insensitive employer match after stripping legal suffixes (Part 5 rule 3)."""
    na, nb = _normalize_employer(a), _normalize_employer(b)
    if not na or not nb:
        return False
    return na == nb or na.startswith(nb) or nb.startswith(na)


def merge_fields(
    merged: dict,
    provenance: dict,
    result,
    subscriber_name: str | None = None,
) -> str:
    """Merge one ProviderResult's fields into `merged` (mutated in place), updating
    `provenance`. Returns 'merged', 'mismatch' (rule 4 discard), or 'empty'.
    """
    fields = result.fields or {}
    if not fields:
        return "empty"

    # Rule 4 — wrong-person guard.
    if not names_overlap(subscriber_name, getattr(result, "full_name", None)):
        logger.warning(
            "provider_mismatch provider=%s subscriber_name=%r provider_name=%r — discarded",
            result.provider_key, subscriber_name, getattr(result, "full_name", None),
        )
        return "mismatch"

    provider = result.provider_key
    is_pdl = provider == "pdl"

    new_emp = fields.get("li_current_employer_name")
    cur_emp = merged.get("li_current_employer_name")
    different_employer = bool(new_emp and cur_emp and not same_employer(new_emp, cur_emp))

    # Rule 3 (different employer): clear the earlier employment block so the later, fresher
    # provider's block fully replaces it.
    if different_employer:
        for k in EMPLOYMENT_FIELDS:
            merged.pop(k, None)
            provenance.pop(k, None)

    for key, val in fields.items():
        if val is None:
            continue

        # Rule 2 — PDL education always overrides.
        if is_pdl and key in EDUCATION_FIELDS:
            merged[key] = val
            provenance[key] = provider
            continue

        # Rule 1 — first-written wins; later providers only fill gaps.
        if merged.get(key) is None:
            merged[key] = val
            provenance[key] = provider

    return "merged"
