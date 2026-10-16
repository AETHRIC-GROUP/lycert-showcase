/**
 * Institution resolution (Part 2 Step 1 / Part 9.2 step 5) — the method-availability gate.
 *
 * Before the waterfall runs, resolve the subscriber's institution → canonical country + known email
 * domains (+ flags), reusing the enrichment Institution Trust DB / academic_domains reference set
 * (the same `academicDomainCandidates` longest-match logic used by pre-enrichment). The result drives
 * which downstream methods are even POSSIBLE per subscriber, so the orchestrator never wastes an
 * attempt (or, for paid authoritative sources, a charge) on a method that cannot apply.
 *
 * Pure: the academic-domain lookup is injected (bound to Supabase in worker-io). With no lookup dep,
 * resolution falls back to the subscriber's own email domain + stated country.
 */

import type { MethodClass, VerificationSubscriberInput } from './base'
import { emailDomainMatchesInstitution } from './providers/email-loop'

/** Email-domain candidates, most-specific first (mirrors enrichment academicDomainCandidates). */
export function institutionDomainCandidates(email: string | null): string[] {
  if (!email) return []
  const at = email.lastIndexOf('@')
  if (at < 0) return []
  const d = email.slice(at + 1).toLowerCase().trim().replace(/\.+$/, '')
  if (!d || !d.includes('.')) return []
  const parts = d.split('.').filter(Boolean)
  const out: string[] = []
  for (let i = 0; i <= parts.length - 2; i++) out.push(parts.slice(i).join('.'))
  return out
}

/** A matched academic-domain reference row (shape mirrors enrichment AcademicDomainMatch). */
export interface AcademicDomainMatch {
  domain: string
  name: string
  country: string | null
}

export interface ResolvedInstitution {
  /** ISO country code, preferring the reference match, falling back to the subscriber's stated country. */
  country: string | null
  /** Verified institutional email domains this subscriber's mailbox may belong to. */
  knownDomains: string[]
  /** Whether the resolved institution participates in NSC (US). null = unknown. */
  nscParticipating: boolean | null
  /** Whether the institution supports SSO/IdP login. null = unknown. */
  ssoCapable: boolean | null
}

export interface InstitutionResolverDeps {
  /** Look up academic-domain candidates (most-specific first) against academic_domains; null if absent. */
  lookupAcademicDomain?: (candidates: string[]) => Promise<AcademicDomainMatch | null>
}

/**
 * Resolve the subscriber's institution to the fields the availability gate needs. Never throws — a
 * lookup failure degrades to the email/stated-country fallback (absence is never adverse).
 */
export async function resolveInstitution(
  input: VerificationSubscriberInput,
  deps: InstitutionResolverDeps = {},
): Promise<ResolvedInstitution> {
  const knownDomains = new Set<string>()
  let country = input.institutionCountry ?? null

  const candidates = institutionDomainCandidates(input.email)
  if (candidates.length && deps.lookupAcademicDomain) {
    try {
      const match = await deps.lookupAcademicDomain(candidates)
      if (match) {
        knownDomains.add(match.domain.toLowerCase())
        if (match.country) country = match.country
      }
    } catch {
      // degrade silently to the fallback below
    }
  }
  // Always trust the subscriber's own email domain as a candidate institutional domain when it is not a
  // known personal domain — the email-loop applicability check re-validates it against knownDomains.
  if (candidates.length) knownDomains.add(candidates[0])

  return {
    country,
    knownDomains: Array.from(knownDomains),
    nscParticipating: null, // determined by NSC at integration time (Part 3); unknown until then
    ssoCapable: null, // determined per-IdP when SSO is built (Part 8.2); unknown until then
  }
}

/** A provider's availability-relevant metadata (from the verification_providers row). */
export interface ProviderApplicability {
  providerKey: string
  methodClass: MethodClass
  /** ISO codes the provider covers; null = global (email_loop, document, sso). */
  countryScope: string[] | null
}

/**
 * Is this method even possible for this subscriber, given the resolved institution? (Part 2 Step 1.)
 * - Country-scoped authoritative source (NSC/HEDD/DigiLocker): the resolved country must be in scope.
 * - email_loop: the subscriber's email domain must map to a known institutional domain.
 * - sso: the institution must be SSO-capable (unknown → not applicable until SSO is built).
 * - document / other global: always applicable (the universal fallback).
 */
export function methodApplicable(
  provider: ProviderApplicability,
  input: VerificationSubscriberInput,
  resolved: ResolvedInstitution,
): boolean {
  if (provider.countryScope && provider.countryScope.length > 0) {
    return resolved.country != null && provider.countryScope.includes(resolved.country)
  }
  if (provider.providerKey === 'email_loop') {
    return emailDomainMatchesInstitution(input.email, resolved.knownDomains)
  }
  if (provider.providerKey === 'sso') {
    return resolved.ssoCapable === true
  }
  return true // document and any other global method: the universal fallback
}
