/**
 * Provider abstraction for the V2 enrichment waterfall — TS port of
 * apps/api/services/enrichment/providers/base.py. The COMPLETE/PARTIAL/MISS rule (Part 2.3) is
 * implemented once here so provider clients and the orchestrator (classifying the merged record)
 * share identical logic.
 */

export enum ProviderOutcome {
  COMPLETE = 'complete',
  PARTIAL = 'partial',
  MISS = 'miss',
  ERROR = 'error',
  PENDING = 'pending', // async providers only
}

export type CanonicalFields = Record<string, unknown>

export type ProviderResult = {
  providerKey: string
  outcome: ProviderOutcome
  fields: CanonicalFields // canonical subscriber_enrichment field names only
  charged: boolean
  costUsd: number
  rawDeleted: boolean // must always be true post-extraction
  errorMessage: string | null
  asyncReference: string | null // enrichment_id for async providers
  fullName: string | null // provider-returned name, for the wrong-person guard (Part 5 rule 4)
}

export function makeResult(
  providerKey: string,
  outcome: ProviderOutcome,
  opts: Partial<Omit<ProviderResult, 'providerKey' | 'outcome'>> = {},
): ProviderResult {
  return {
    providerKey,
    outcome,
    fields: opts.fields ?? {},
    charged: opts.charged ?? false,
    costUsd: opts.costUsd ?? 0,
    rawDeleted: opts.rawDeleted ?? true,
    errorMessage: opts.errorMessage ?? null,
    asyncReference: opts.asyncReference ?? null,
    fullName: opts.fullName ?? null,
  }
}

/** Canonical enrichment fields a provider may populate. The orchestrator owns everything else
 * on the row (subscriber_id, tenant_id, enrichment_provider, timestamps, provenance). */
export const CANONICAL_ENRICHMENT_FIELDS: ReadonlySet<string> = new Set([
  'linkedin_profile_url',
  'li_job_title',
  'li_job_title_levels',
  'li_current_employer_name',
  'li_current_employer_domain',
  'li_current_employer_linkedin_url',
  'li_employer_size',
  'li_employer_industry',
  'li_job_start_date',
  'li_job_end_date',
  'li_education_institution',
  'li_education_end_date',
  'li_country',
  'li_state',
  'li_city',
  'li_skills',
  'pdl_person_id',
  'pdl_likelihood_score',
])

function hasValue(fields: CanonicalFields, key: string): boolean {
  return key in fields && fields[key] != null
}

/**
 * Shared COMPLETE / PARTIAL / MISS rule (Part 2.3).
 * COMPLETE requires ALL of:
 *   1. linkedin_profile_url OR (li_current_employer_name AND li_job_title)
 *   2. li_job_start_date present (li_job_end_date may be present or explicitly null)
 *   3. li_education_end_date present
 * PARTIAL — anything found but missing (2) or (3). MISS — nothing usable.
 */
export function classifyCompleteness(fields: CanonicalFields): ProviderOutcome {
  const hasAny = Object.values(fields).some(v => v != null)
  if (!hasAny) return ProviderOutcome.MISS

  const hasIdentity =
    hasValue(fields, 'linkedin_profile_url') ||
    (hasValue(fields, 'li_current_employer_name') && hasValue(fields, 'li_job_title'))
  const hasEmploymentDates = hasValue(fields, 'li_job_start_date')
  const hasEducation = hasValue(fields, 'li_education_end_date')

  if (hasIdentity && hasEmploymentDates && hasEducation) return ProviderOutcome.COMPLETE
  return ProviderOutcome.PARTIAL
}

/** Keep ONLY canonical enrichment fields, dropping null/undefined (GDPR structural guard, Part 5 rule 6). */
export function stripToCanonical(fields: CanonicalFields): CanonicalFields {
  const out: CanonicalFields = {}
  for (const [k, v] of Object.entries(fields)) {
    if (CANONICAL_ENRICHMENT_FIELDS.has(k) && v != null) out[k] = v
  }
  return out
}

/** Every provider client implements this. */
export interface EnrichmentProvider {
  providerKey: string
  executionMode: 'sync' | 'async'
  enrich(email: string, name: string | null, subscriberId: string): Promise<ProviderResult>
}
