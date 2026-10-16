/**
 * Institution resolution + the method-availability gate (Part 2 Step 1 / Part 9.2 step 5).
 */
import { describe, it, expect } from 'vitest'
import {
  institutionDomainCandidates,
  resolveInstitution,
  methodApplicable,
  type AcademicDomainMatch,
  type ProviderApplicability,
} from './institution'
import type { VerificationSubscriberInput } from './base'

const base: VerificationSubscriberInput = {
  subscriberId: 's', tenantId: 't', email: 'jane@cs.stanford.edu', name: 'Jane',
  institutionName: 'Stanford', institutionCountry: null, statedGraduationDate: null,
}

describe('institutionDomainCandidates', () => {
  it('emits most-specific-first candidates, stopping at two labels', () => {
    expect(institutionDomainCandidates('jane@cs.stanford.edu')).toEqual(['cs.stanford.edu', 'stanford.edu'])
    expect(institutionDomainCandidates('jane@stanford.edu')).toEqual(['stanford.edu'])
    expect(institutionDomainCandidates('jane@gmail.com')).toEqual(['gmail.com'])
    expect(institutionDomainCandidates(null)).toEqual([])
    expect(institutionDomainCandidates('not-an-email')).toEqual([])
  })
})

describe('resolveInstitution', () => {
  it('uses the academic_domains match for known domains + ISO country', async () => {
    const lookupAcademicDomain = async (c: string[]): Promise<AcademicDomainMatch | null> =>
      c.includes('stanford.edu') ? { domain: 'stanford.edu', name: 'Stanford University', country: 'US' } : null
    const r = await resolveInstitution(base, { lookupAcademicDomain })
    expect(r.country).toBe('US')
    expect(r.knownDomains).toContain('stanford.edu')
  })

  it('falls back to the email domain + stated country when no reference match', async () => {
    const r = await resolveInstitution({ ...base, institutionCountry: 'US' }, { lookupAcademicDomain: async () => null })
    expect(r.country).toBe('US')
    expect(r.knownDomains).toContain('cs.stanford.edu')
  })

  it('degrades silently when the lookup throws', async () => {
    const r = await resolveInstitution(base, { lookupAcademicDomain: async () => { throw new Error('db down') } })
    expect(r.knownDomains).toContain('cs.stanford.edu') // still has the email fallback
  })
})

describe('methodApplicable', () => {
  const resolvedUS = { country: 'US', knownDomains: ['stanford.edu'], nscParticipating: null, ssoCapable: null }
  const nsc: ProviderApplicability = { providerKey: 'nsc', methodClass: 'authoritative', countryScope: ['US'] }
  const hedd: ProviderApplicability = { providerKey: 'hedd', methodClass: 'authoritative', countryScope: ['GB'] }
  const emailLoop: ProviderApplicability = { providerKey: 'email_loop', methodClass: 'semi_authoritative', countryScope: null }
  const sso: ProviderApplicability = { providerKey: 'sso', methodClass: 'authoritative', countryScope: null }
  const doc: ProviderApplicability = { providerKey: 'document', methodClass: 'document', countryScope: null }

  it('country-scoped source applies only when the resolved country is in scope', () => {
    expect(methodApplicable(nsc, base, resolvedUS)).toBe(true)
    expect(methodApplicable(hedd, base, resolvedUS)).toBe(false)
    expect(methodApplicable(nsc, base, { ...resolvedUS, country: null })).toBe(false)
  })

  it('email_loop applies only when the email maps to a known institutional domain', () => {
    expect(methodApplicable(emailLoop, { ...base, email: 'jane@stanford.edu' }, resolvedUS)).toBe(true)
    expect(methodApplicable(emailLoop, { ...base, email: 'jane@gmail.com' }, resolvedUS)).toBe(false)
  })

  it('sso applies only when the institution is SSO-capable; document is the universal fallback', () => {
    expect(methodApplicable(sso, base, resolvedUS)).toBe(false) // ssoCapable null → not yet
    expect(methodApplicable(sso, base, { ...resolvedUS, ssoCapable: true })).toBe(true)
    expect(methodApplicable(doc, base, resolvedUS)).toBe(true)
  })
})
