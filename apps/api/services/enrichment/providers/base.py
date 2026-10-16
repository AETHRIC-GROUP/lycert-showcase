"""Provider abstraction for the V2 enrichment waterfall.

LYCERT_WATERFALL_ENRICHMENT_V2.md Part 4.1. Every provider client implements the same
interface so the orchestrator can drive a registry-defined cascade uniformly.

The COMPLETE / PARTIAL / MISS rule (Part 2.3) is implemented ONCE here as a module-level
function so both provider clients AND the orchestrator (which classifies the *merged* record)
use identical logic.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class ProviderOutcome(str, Enum):
    COMPLETE = "complete"
    PARTIAL = "partial"
    MISS = "miss"
    ERROR = "error"
    PENDING = "pending"        # async providers only


@dataclass
class ProviderResult:
    provider_key: str
    outcome: ProviderOutcome
    fields: dict[str, Any] = field(default_factory=dict)   # canonical subscriber_enrichment field names only
    charged: bool = False
    cost_usd: float = 0.0
    raw_deleted: bool = True                               # must always be True post-extraction
    error_message: str | None = None
    async_reference: str | None = None                     # enrichment_id for async providers
    full_name: str | None = None                           # provider-returned name, for the wrong-person guard (Part 5 rule 4)


# Canonical enrichment fields a provider may populate. The orchestrator owns everything
# else on the row (subscriber_id, tenant_id, enrichment_provider, timestamps, provenance).
CANONICAL_ENRICHMENT_FIELDS: frozenset[str] = frozenset({
    "linkedin_profile_url",
    "li_job_title",
    "li_job_title_levels",
    "li_current_employer_name",
    "li_current_employer_domain",
    "li_current_employer_linkedin_url",
    "li_employer_size",
    "li_employer_industry",
    "li_job_start_date",
    "li_job_end_date",
    "li_education_institution",
    "li_education_end_date",
    "li_country",
    "li_state",
    "li_city",
    "li_skills",
    "pdl_person_id",
    "pdl_likelihood_score",
})


def _has_value(fields: dict[str, Any], key: str) -> bool:
    return key in fields and fields[key] is not None


def classify_completeness(fields: dict[str, Any]) -> ProviderOutcome:
    """Shared COMPLETE / PARTIAL / MISS rule — Part 2.3.

    COMPLETE requires ALL of:
      1. linkedin_profile_url  OR  (li_current_employer_name AND li_job_title)
      2. employment dates present — li_job_start_date present
         (li_job_end_date may be present OR explicitly null = currently employed)
      3. li_education_end_date present

    PARTIAL — anything found, but missing requirement 2 or 3.
    MISS    — nothing usable found at all.
    """
    has_any = any(v is not None for v in fields.values())
    if not has_any:
        return ProviderOutcome.MISS

    has_identity = _has_value(fields, "linkedin_profile_url") or (
        _has_value(fields, "li_current_employer_name") and _has_value(fields, "li_job_title")
    )
    has_employment_dates = _has_value(fields, "li_job_start_date")
    has_education = _has_value(fields, "li_education_end_date")

    if has_identity and has_employment_dates and has_education:
        return ProviderOutcome.COMPLETE
    return ProviderOutcome.PARTIAL


class EnrichmentProvider(ABC):
    """Base class for every enrichment provider in the waterfall."""

    provider_key: str
    execution_mode: str  # 'sync' | 'async'

    @abstractmethod
    async def enrich(self, email: str, name: str | None, subscriber_id: str) -> ProviderResult:
        """Run the provider for one subscriber and return canonical fields + outcome."""
        ...

    def classify_completeness(self, fields: dict[str, Any]) -> ProviderOutcome:
        """Instance convenience wrapper around the shared module-level rule (Part 2.3)."""
        return classify_completeness(fields)
