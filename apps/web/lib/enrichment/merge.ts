/**
 * Multi-provider field merge engine — TS port of apps/api/services/enrichment/merge.py (Part 5).
 *
 * Rules:
 *  1. First-written wins per field (earlier providers are cheaper) — EXCEPT rule 2.
 *  2. PDL education override: PDL's li_education_* overwrite earlier values.
 *  3. Employment-date completion: same employer → merge dates in; different employer → the later
 *     provider's full employment block replaces the earlier one (real-time providers are fresher).
 *  4. Never merge across people: zero name-token overlap → discard the result (provider_mismatch).
 *  5. Every written field records its provider in provenance.
 *  6. GDPR exclusions enforced at the mapper level (stripToCanonical).
 */
import type { CanonicalFields, ProviderResult } from './providers/base'

export const EMPLOYMENT_FIELDS: ReadonlySet<string> = new Set([
  'li_current_employer_name',
  'li_current_employer_domain',
  'li_current_employer_linkedin_url',
  'li_employer_size',
  'li_employer_industry',
  'li_job_title',
  'li_job_title_levels',
  'li_job_start_date',
  'li_job_end_date',
])

export const EDUCATION_FIELDS: ReadonlySet<string> = new Set([
  'li_education_institution',
  'li_education_end_date',
])

const LEGAL_SUFFIXES = new Set([
  'gmbh', 'inc', 'incorporated', 'ltd', 'limited', 'llc', 'co', 'corp', 'corporation',
  'ag', 'sa', 'sas', 'sarl', 'bv', 'plc', 'kg', 'kgaa', 'ug', 'oy', 'ab', 'as', 'spa', 'srl',
])
const TOKEN_RE = /[a-z0-9]+/g

function nameTokens(name: string | null | undefined): Set<string> {
  if (!name) return new Set()
  return new Set((name.toLowerCase().match(TOKEN_RE) ?? []).filter(t => t.length >= 2))
}

/** Part 5 rule 4 guard. True if names share a token, or we lack a name to judge (never a mismatch then). */
export function namesOverlap(subscriberName: string | null | undefined, providerFullName: string | null | undefined): boolean {
  if (!subscriberName || !providerFullName) return true
  const a = nameTokens(subscriberName)
  const b = nameTokens(providerFullName)
  if (a.size === 0 || b.size === 0) return true
  return Array.from(a).some(x => b.has(x))
}

function normalizeEmployer(name: string | null | undefined): string {
  if (!name) return ''
  const tokens = (name.toLowerCase().match(TOKEN_RE) ?? []).filter(t => !LEGAL_SUFFIXES.has(t))
  return tokens.join(' ').trim()
}

/** Case-insensitive employer match after stripping legal suffixes (Part 5 rule 3). */
export function sameEmployer(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeEmployer(a)
  const nb = normalizeEmployer(b)
  if (!na || !nb) return false
  return na === nb || na.startsWith(nb) || nb.startsWith(na)
}

export type MergeStatus = 'merged' | 'mismatch' | 'empty'

/**
 * Merge one ProviderResult's fields into `merged` (mutated), updating `provenance`.
 * Returns 'merged', 'mismatch' (rule 4 discard), or 'empty'.
 */
export function mergeFields(
  merged: CanonicalFields,
  provenance: Record<string, string>,
  result: Pick<ProviderResult, 'providerKey' | 'fields' | 'fullName'>,
  subscriberName: string | null = null,
): MergeStatus {
  const fields = result.fields ?? {}
  if (Object.keys(fields).length === 0) return 'empty'

  // Rule 4 — wrong-person guard.
  if (!namesOverlap(subscriberName, result.fullName)) return 'mismatch'

  const provider = result.providerKey
  const isPdl = provider === 'pdl'

  const newEmp = fields['li_current_employer_name'] as string | undefined
  const curEmp = merged['li_current_employer_name'] as string | undefined
  const differentEmployer = Boolean(newEmp && curEmp && !sameEmployer(newEmp, curEmp))

  // Rule 3 (different employer): clear the earlier employment block so the fresher one replaces it.
  if (differentEmployer) {
    EMPLOYMENT_FIELDS.forEach(k => {
      delete merged[k]
      delete provenance[k]
    })
  }

  for (const [key, val] of Object.entries(fields)) {
    if (val == null) continue

    // Rule 2 — PDL education always overrides.
    if (isPdl && EDUCATION_FIELDS.has(key)) {
      merged[key] = val
      provenance[key] = provider
      continue
    }

    // Rule 1 — first-written wins; later providers only fill gaps.
    if (merged[key] == null) {
      merged[key] = val
      provenance[key] = provider
    }
  }

  return 'merged'
}
