"""Enrichment provider registry — LYCERT_WATERFALL_ENRICHMENT_V2.md Part 4.

PROVIDER_REGISTRY maps a provider_key (as stored in the enrichment_providers table) to its
client class. The orchestrator loads the ordered cascade from the DB (enrichment_providers +
tenant_waterfall_config) and instantiates classes from this registry.

ZeroBounce is the Stage 0 validation gate (provider_type='validation'), not part of the
enrichment cascade loop — it is still registered so the Settings UI can test its connection.
"""

from services.enrichment.providers.apollo_client import ApolloProvider
from services.enrichment.providers.base import (
    EnrichmentProvider,
    ProviderOutcome,
    ProviderResult,
    classify_completeness,
)
from services.enrichment.providers.datagma_client import DatagmaClient
from services.enrichment.providers.fullenrich_client import FullEnrichClient
from services.enrichment.providers.hunter_client import HunterClient
from services.enrichment.providers.pdl_client import PDLProvider
from services.enrichment.providers.reversecontact_client import ReverseContactClient
from services.enrichment.providers.zerobounce_client import ZeroBounceClient

PROVIDER_REGISTRY: dict[str, type] = {
    "zerobounce": ZeroBounceClient,
    "hunter": HunterClient,
    "reversecontact": ReverseContactClient,
    "datagma": DatagmaClient,
    "pdl": PDLProvider,
    "fullenrich": FullEnrichClient,
    "apollo": ApolloProvider,
}

__all__ = [
    "PROVIDER_REGISTRY",
    "EnrichmentProvider",
    "ProviderOutcome",
    "ProviderResult",
    "classify_completeness",
    "ZeroBounceClient",
    "HunterClient",
    "ReverseContactClient",
    "DatagmaClient",
    "PDLProvider",
    "FullEnrichClient",
    "ApolloProvider",
]
