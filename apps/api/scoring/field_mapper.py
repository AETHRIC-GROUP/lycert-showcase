"""Field mapper — translates a client's raw data dict into a canonical SubscriberRecord.

Each tenant configures their column names in tenant_field_mappings.
The mapper uses those configurations to extract and type-convert the right fields.
Missing fields score 0 and appear in data_gaps — they are never an error.
"""
from __future__ import annotations
import re
import logging
from datetime import date, datetime
from typing import Any
from scoring.models import SubscriberRecord

logger = logging.getLogger(__name__)

# Mapping: canonical field → type converter
_FIELD_TYPES: dict[str, str] = {
    "email": "str",
    "account_name": "str",
    "institution_name": "str",
    "institution_location": "str",
    "account_country": "str",
    "stated_graduation_date": "date",
    "renewal_delta_days": "int",
    "proof_submission_date": "date",
    "subscription_start_date": "date",
    "subscription_end_date": "date",
    "li_current_employer_name": "str",
    "li_job_end_date": "date_or_none",  # blank/missing = None = currently employed
    "li_job_title": "str",
    "li_education_end_date": "date",    # extracted from free-text education date range
    "li_current_employer_domain": "str",
}


def _parse_date(value: Any) -> date | None:
    """Parse a date from various string and numeric formats. Returns None on failure."""
    if value is None:
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    s = str(value).strip()
    if not s or s.lower() in ("nan", "nat", "none", ""):
        return None
    s = s.split(" ")[0].split("T")[0]
    for fmt in ("%Y-%m-%d", "%d.%m.%y", "%d.%m.%Y", "%m/%d/%Y", "%m/%d/%y",
                "%d/%m/%Y", "%d/%m/%y", "%Y/%m/%d"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    # Try Excel serial number (days since 1899-12-30)
    try:
        serial = float(s)
        if 1000 < serial < 100000:
            from datetime import timedelta
            return (date(1899, 12, 30) + timedelta(days=int(serial)))
    except (ValueError, TypeError):
        pass
    return None


def _extract_education_year(value: Any) -> date | None:
    """Extract the latest 4-digit year from a free-text education date range.
    E.g. '2019 – 2023' → date(2023, 1, 1).
    Returns None if no year found.
    """
    if not value:
        return None
    years = re.findall(r"\b(20\d{2}|19\d{2})\b", str(value))
    if not years:
        return None
    return date(max(int(y) for y in years), 1, 1)


def _coerce(canonical: str, value: Any) -> Any:
    """Coerce a raw value to the expected type for a canonical field."""
    field_type = _FIELD_TYPES.get(canonical, "str")

    if field_type == "str":
        return "" if value is None else str(value).strip()
    if field_type == "int":
        if value is None:
            return None
        try:
            return int(float(str(value)))
        except (ValueError, TypeError):
            return None
    if field_type == "date":
        if canonical == "li_education_end_date":
            return _extract_education_year(value)
        return _parse_date(value)
    if field_type == "date_or_none":
        # Blank/empty = None (currently employed). Non-empty = parse as date.
        if value is None:
            return None
        s = str(value).strip()
        if not s or s.lower() in ("nan", "nat", "none", ""):
            return None
        return _parse_date(value)
    return value


def map_row(
    raw: dict[str, Any],
    mappings: list[dict[str, str]],
) -> SubscriberRecord:
    """Map a raw data row to a SubscriberRecord using tenant field mappings.

    Args:
        raw: Dict of {client_column_name: value} from CSV or API
        mappings: List of {canonical_field, client_field_name} dicts from tenant_field_mappings table

    Returns:
        SubscriberRecord with all available fields populated.
        Fields not in mappings default to empty/None (never raise).
    """
    resolved: dict[str, Any] = {}

    for mapping in mappings:
        canonical = mapping.get("canonical_field", "")
        client_field = mapping.get("client_field_name") or ""
        formula = mapping.get("calculation_formula") or ""
        source_fields = mapping.get("source_fields") or []

        if canonical not in _FIELD_TYPES:
            continue

        if client_field and client_field in raw:
            resolved[canonical] = _coerce(canonical, raw[client_field])
        elif formula and source_fields:
            # Simple calculated fields — renewal_delta_days from two date fields
            try:
                resolved[canonical] = _apply_formula(formula, source_fields, raw)
            except Exception:
                logger.debug("Formula evaluation failed for %s", canonical)
        # If neither client_field nor formula matches, field stays absent (defaults to None/empty)

    return SubscriberRecord(**resolved)


def _apply_formula(formula: str, source_fields: list[str], raw: dict[str, Any]) -> Any:
    """Evaluate simple calculated fields. Currently supports renewal_delta_days calculation."""
    if "renewal_delta" in formula.lower() and len(source_fields) >= 2:
        d1 = _parse_date(raw.get(source_fields[0]))
        d2 = _parse_date(raw.get(source_fields[1]))
        if d1 and d2:
            return (d1 - d2).days
    return None
