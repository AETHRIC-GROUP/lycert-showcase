/**
 * Provider registry/factory. Maps a provider_key (from enrichment_providers) to a constructed
 * client. ZeroBounce (validation gate) is built separately by the orchestrator, not in the cascade.
 */
import type { EnrichmentProvider } from './base'
import { ApolloClient, DatagmaClient, HunterClient, PdlClient, ReverseContactClient } from './clients'
import { FullEnrichClient } from './fullenrich'

export type ProviderKeys = {
  hunter?: string
  reversecontact?: string
  datagma?: string
  pdl?: string
  apollo?: string
  fullenrich?: string
  fullenrichWebhookUrl?: string
}

export const ENRICHMENT_PROVIDER_KEYS = ['hunter', 'reversecontact', 'datagma', 'pdl', 'apollo', 'fullenrich'] as const

/** Construct a cascade provider by key, or null if unknown. */
export function makeProvider(key: string, keys: ProviderKeys, jobId: string | null = null): EnrichmentProvider | null {
  switch (key) {
    case 'hunter': return new HunterClient(keys.hunter ?? '')
    case 'reversecontact': return new ReverseContactClient(keys.reversecontact ?? '')
    case 'datagma': return new DatagmaClient(keys.datagma ?? '')
    case 'pdl': return new PdlClient(keys.pdl ?? '')
    case 'apollo': return new ApolloClient(keys.apollo ?? '')
    case 'fullenrich': return new FullEnrichClient(keys.fullenrich ?? '', keys.fullenrichWebhookUrl ?? '', jobId)
    default: return null
  }
}

export * from './base'
export { ZeroBounceClient, interpret as interpretZeroBounce } from './zerobounce'
export { parseWebhookResults, withWebhookToken, FullEnrichClient } from './fullenrich'
