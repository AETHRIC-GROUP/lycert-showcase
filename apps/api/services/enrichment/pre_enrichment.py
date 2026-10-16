"""Pre-enrichment — free intelligence layer that runs at subscriber import time.

Four operations, all free (no PDL credits consumed):
  1. School Cleaner → normalise institution_name (display_name), get domain + country
     → Upsert institutions table (spec 1.6 step 4)
     → Load trust_tier from institutions table
  2. Location Cleaner × 2 → account_location AND institution_location (spec 1.7)
  3. Email domain classification (spec Part 2.1 step 3)
  4. compute_enrichment_priority → stored in enrichment_priority (spec Part 3.2)

Reference: LYCERT_ENRICHMENT_ARCHITECTURE.md Parts 1.6, 1.7, 2.1, 3.2
"""

import logging
import re
from typing import Any

from services.enrichment.providers.pdl_client import clean_school, clean_location
from services.enrichment.field_mapper import (
    map_school_cleaner,
    map_school_cleaner_for_institutions,
    map_location_cleaner,
)
from services.enrichment.priority_queue import compute_enrichment_priority

logger = logging.getLogger(__name__)

# ── Email domain classification ────────────────────────────────────────────────

_PERSONAL_DOMAINS = frozenset({
    "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "yahoo.de",
    "yahoo.fr", "hotmail.com", "hotmail.co.uk", "hotmail.de", "outlook.com",
    "live.com", "msn.com", "icloud.com", "me.com", "mac.com",
    "aol.com", "protonmail.com", "proton.me", "tutanota.com",
    "web.de", "gmx.de", "gmx.net", "freenet.de", "t-online.de",
    "mail.ru", "yandex.ru", "yandex.com",
})

_ACADEMIC_TLD_PATTERNS = [
    r"\.edu$",
    r"\.ac\.[a-z]{2}$",
    r"\.edu\.[a-z]{2}$",
    r"(^|\.)uni-[a-z]+\.[a-z]+$",
    r"(^|\.)fh-[a-z]+\.[a-z]+$",
    r"(^|\.)th-[a-z]+\.[a-z]+$",
    r"(^|\.)hs-[a-z]+\.[a-z]+$",
]
_ACADEMIC_TLD_RE = re.compile("|".join(_ACADEMIC_TLD_PATTERNS), re.IGNORECASE)

_DISPOSABLE_DOMAINS = frozenset({
    "mailinator.com", "guerrillamail.com", "temp-mail.org", "10minutemail.com",
    "throwaway.email", "yopmail.com", "fakeinbox.com", "sharklasers.com",
    "trashmail.com", "dispostable.com", "maildrop.cc",
})


def classify_email_domain(email: str, institution_domain_verified: str | None = None) -> str:
    """Classify an email address domain → 'academic'|'personal'|'corporate'|'disposable'."""
    if not email or "@" not in email:
        return "corporate"
    domain = email.split("@", 1)[1].lower().strip()
    if institution_domain_verified and domain == institution_domain_verified.lower():
        return "academic"
    if _ACADEMIC_TLD_RE.search(domain):
        return "academic"
    if domain in _PERSONAL_DOMAINS:
        return "personal"
    if domain in _DISPOSABLE_DOMAINS:
        return "disposable"
    return "corporate"


# ── Institutions table upsert ──────────────────────────────────────────────────

def _upsert_institution(db: Any, school_raw: dict[str, Any]) -> str | None:
    """Upsert institutions table and return trust_tier.

    Spec 1.6 step 4:
      - If domain already in table → return its existing trust_tier
      - If not found → insert with source='pdl_school_cleaner', trust_tier='medium'
    Always uses service role — institutions table has no INSERT policy for authenticated users.
    """
    fields = map_school_cleaner_for_institutions(school_raw)
    domain = fields.get("domain")
    if not domain:
        return "medium"

    try:
        existing = (
            db.table("institutions")
            .select("id, trust_tier")
            .eq("domain", domain)
            .maybe_single()
            .execute()
        ).data

        if existing:
            return existing.get("trust_tier", "medium")

        db.table("institutions").insert(fields).execute()
        return "medium"
    except Exception:
        logger.exception("_upsert_institution failed domain=%s", domain)
        return None


# ── Main pre-enrichment entry point ───────────────────────────────────────────

async def run_pre_enrichment(
    subscriber: dict[str, Any],
    db: Any = None,
) -> dict[str, Any]:
    """Run all four free pre-enrichment steps for one subscriber.

    Input keys used: email, institution_name, account_location,
                     institution_location, stated_graduation_date, auto_renew
    Returns: dict of column updates to apply to the subscribers row.
    Never raises — API failures produce partial results, not hard errors.
    """
    updates: dict[str, Any] = {}

    institution_name = subscriber.get("institution_name")
    account_location = subscriber.get("account_location")
    institution_location = subscriber.get("institution_location")
    email = subscriber.get("email", "")
    institution_domain_verified: str | None = None

    # ── Step 1: School Cleaner (spec 1.6) ─────────────────────────────────────
    if institution_name:
        try:
            school_raw = await clean_school(institution_name)
            if school_raw:
                updates.update(map_school_cleaner(school_raw))
                institution_domain_verified = updates.get("institution_domain_verified")

                # Upsert institutions table + load trust_tier (spec 1.6 step 4)
                if db is not None:
                    trust_tier = _upsert_institution(db, school_raw)
                    if trust_tier:
                        updates["institution_trust_tier"] = trust_tier
                logger.info(
                    "pre_enrich: school=%s → domain=%s country=%s",
                    institution_name,
                    institution_domain_verified,
                    updates.get("institution_country_normalized"),
                )
            else:
                updates["institution_pdl_verified"] = False
                logger.info("pre_enrich: school_cleaner miss institution=%s", institution_name)
        except Exception:
            logger.exception("pre_enrich: school_cleaner error institution=%s", institution_name)
            updates["institution_pdl_verified"] = False

    # ── Step 2a: Location Cleaner — account_location (spec 1.7) ──────────────
    if account_location:
        try:
            loc_raw = await clean_location(account_location)
            if loc_raw:
                updates.update(map_location_cleaner(loc_raw))
                logger.info(
                    "pre_enrich: account_location='%s' → %s",
                    account_location,
                    updates.get("account_country_normalized"),
                )
        except Exception:
            logger.exception("pre_enrich: location_cleaner error '%s'", account_location)

    # ── Step 2b: Location Cleaner — institution_location (spec 1.7) ──────────
    if institution_location:
        try:
            inst_loc_raw = await clean_location(institution_location)
            if inst_loc_raw:
                inst_country = inst_loc_raw.get("country")
                # Only set if School Cleaner didn't already provide a country
                if inst_country and not updates.get("institution_country_normalized"):
                    updates["institution_country_normalized"] = inst_country
                logger.info(
                    "pre_enrich: institution_location='%s' → %s",
                    institution_location,
                    inst_country,
                )
        except Exception:
            logger.exception("pre_enrich: location_cleaner error institution_location='%s'", institution_location)

    # ── Step 3: Email domain classification ───────────────────────────────────
    updates["email_domain_type"] = classify_email_domain(email, institution_domain_verified)

    # ── Step 4: Enrichment priority score (spec Part 3.2) ─────────────────────
    sub_snapshot = {**subscriber, **updates}
    updates["enrichment_priority"] = compute_enrichment_priority(sub_snapshot)

    return updates
