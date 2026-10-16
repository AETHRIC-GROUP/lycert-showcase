/** Pre-enrichment unit tests — fixtures only, IO injected. */
import { describe, it, expect } from 'vitest'
import {
  classifyEmailDomain,
  academicDomainCandidates,
  computeEnrichmentPriority,
  mapSchoolCleaner,
  mapSchoolCleanerForInstitutions,
  mapLocationCleaner,
  runPreEnrichment,
  type PreEnrichDeps,
  type RawCleaner,
} from './pre-enrichment'

describe('classifyEmailDomain', () => {
  it('classifies the domain categories', () => {
    expect(classifyEmailDomain('a@gmail.com')).toBe('personal')
    expect(classifyEmailDomain('a@mit.edu')).toBe('academic')
    expect(classifyEmailDomain('a@uni-stuttgart.de')).toBe('academic')
    expect(classifyEmailDomain('a@mailinator.com')).toBe('disposable')
    expect(classifyEmailDomain('a@acme.io')).toBe('corporate')
    expect(classifyEmailDomain('bad')).toBe('corporate')
  })
  it('treats the verified institution domain as academic', () => {
    expect(classifyEmailDomain('a@acme.io', 'acme.io')).toBe('academic')
  })
  it('cross-links a subdomain of the verified institution domain (real student-mail pattern)', () => {
    // Student A: edu.cegepgarneau.ca is a subdomain of the verified cegepgarneau.ca.
    expect(classifyEmailDomain('student.a@edu.cegepgarneau.ca', 'cegepgarneau.ca')).toBe('academic')
    // Tolerate a leading "@" or wildcard "*." on the stored verified domain.
    expect(classifyEmailDomain('a@campus.ul.pt', '*.ul.pt')).toBe('academic')
    // Must NOT match a mere suffix collision (foocegepgarneau.ca is not under cegepgarneau.ca).
    expect(classifyEmailDomain('a@evilcegepgarneau.ca', 'cegepgarneau.ca')).toBe('corporate')
  })
  it('recognises edu./student. academic subdomains without a cross-link', () => {
    expect(classifyEmailDomain('student.a@edu.cegepgarneau.ca')).toBe('academic')
    expect(classifyEmailDomain('a@student.someschool.org')).toBe('academic')
  })
})

describe('academicDomainCandidates', () => {
  it('strips progressively, most-specific first, stopping at two labels', () => {
    expect(academicDomainCandidates('campus.ul.pt')).toEqual(['campus.ul.pt', 'ul.pt'])
    expect(academicDomainCandidates('edu.cegepgarneau.ca')).toEqual(['edu.cegepgarneau.ca', 'cegepgarneau.ca'])
    expect(academicDomainCandidates('um.edu.mt')).toEqual(['um.edu.mt', 'edu.mt'])
  })
  it('never generates a bare public suffix / single label', () => {
    expect(academicDomainCandidates('campus.ul.pt')).not.toContain('pt')
    expect(academicDomainCandidates('acme.com')).toEqual(['acme.com']) // 2-label domain → itself only
    expect(academicDomainCandidates('localhost')).toEqual([]) // no dot
    expect(academicDomainCandidates('')).toEqual([])
  })
})

describe('computeEnrichmentPriority', () => {
  const TODAY = new Date('2026-05-17')
  it('adds graduation-timing + domain + trust + auto_renew', () => {
    const s = computeEnrichmentPriority(
      { stated_graduation_date: '2024-01-01', email_domain_type: 'corporate', auto_renew: true },
      TODAY,
    )
    expect(s).toBe(40 + 25 + 5) // >365d grad + corporate + auto_renew
  })
  it('academic email + future grad scores low; caps at 100', () => {
    expect(computeEnrichmentPriority({ email_domain_type: 'academic' }, TODAY)).toBe(0)
    expect(computeEnrichmentPriority(
      { stated_graduation_date: '2024-01-01', email_domain_type: 'disposable', institution_trust_tier: 'suspicious', auto_renew: true },
      TODAY,
    )).toBe(Math.min(40 + 20 + 20 + 5, 100))
  })
})

describe('school/location mappers', () => {
  const school: RawCleaner = {
    display_name: 'University of Stuttgart', name: 'Uni Stuttgart', domain: 'uni-stuttgart.de',
    type: 'university', location: { country: 'Germany' },
  }
  it('mapSchoolCleaner extracts normalized name/domain/country', () => {
    expect(mapSchoolCleaner(school)).toEqual({
      institution_name_normalized: 'University of Stuttgart',
      institution_domain_verified: 'uni-stuttgart.de',
      institution_country_normalized: 'Germany',
      institution_pdl_verified: true,
    })
  })
  it('mapSchoolCleanerForInstitutions maps type + degree_granting', () => {
    const f = mapSchoolCleanerForInstitutions(school)
    expect(f.institution_type).toBe('research_university')
    expect(f.degree_granting).toBe(true)
    expect(f.source).toBe('pdl_school_cleaner')
    expect(f.trust_tier).toBe('medium')
  })
  it('mapLocationCleaner pulls country', () => {
    expect(mapLocationCleaner({ country: 'France' })).toEqual({ account_country_normalized: 'France' })
  })
})

describe('runPreEnrichment', () => {
  const baseDeps = (over: Partial<PreEnrichDeps> = {}): PreEnrichDeps => ({
    cleanSchool: async () => null,
    cleanLocation: async () => null,
    upsertInstitution: async () => 'medium',
    ...over,
  })

  it('school hit populates institution fields + trust tier', async () => {
    const deps = baseDeps({
      cleanSchool: async () => ({ display_name: 'MIT', domain: 'mit.edu', type: 'university', location: { country: 'United States' } }),
      upsertInstitution: async () => 'high',
    })
    const u = await runPreEnrichment({ email: 'a@mit.edu', institution_name: 'MIT' }, deps)
    expect(u.institution_name_normalized).toBe('MIT')
    expect(u.institution_domain_verified).toBe('mit.edu')
    expect(u.institution_country_normalized).toBe('United States')
    expect(u.institution_pdl_verified).toBe(true)
    expect(u.institution_trust_tier).toBe('high')
    expect(u.email_domain_type).toBe('academic') // .edu
  })

  it('school miss sets institution_pdl_verified=false', async () => {
    const u = await runPreEnrichment({ email: 'a@gmail.com', institution_name: 'Nowhere U' }, baseDeps())
    expect(u.institution_pdl_verified).toBe(false)
    expect(u.email_domain_type).toBe('personal')
  })

  it('uses a pre-existing institution_domain_verified for the email cross-link when the cleaner resolves none', async () => {
    // No PDL hit (cleanSchool returns null), but the subscriber already has a verified domain.
    const u = await runPreEnrichment(
      { email: 'student.a@edu.cegepgarneau.ca', institution_name: 'cegep garneau', institution_domain_verified: 'cegepgarneau.ca' },
      baseDeps(),
    )
    expect(u.email_domain_type).toBe('academic')
  })

  it('location cleaner sets account_country_normalized', async () => {
    const deps = baseDeps({ cleanLocation: async () => ({ country: 'Spain' }) })
    const u = await runPreEnrichment({ email: 'a@x.io', account_location: 'Barcelona, Spain' }, deps)
    expect(u.account_country_normalized).toBe('Spain')
  })

  it('institution_location only fills country when school cleaner did not', async () => {
    // School provides Germany; institution_location says France → school wins.
    const deps = baseDeps({
      cleanSchool: async () => ({ name: 'X', domain: 'x.de', type: 'university', location: { country: 'Germany' } }),
      cleanLocation: async (loc) => ({ country: loc.includes('Paris') ? 'France' : 'Other' }),
    })
    const u = await runPreEnrichment(
      { email: 'a@x.de', institution_name: 'X', institution_location: 'Paris, France' }, deps,
    )
    expect(u.institution_country_normalized).toBe('Germany')
  })

  it('never throws on cleaner error — returns partial result', async () => {
    const deps = baseDeps({ cleanSchool: async () => { throw new Error('pdl down') } })
    const u = await runPreEnrichment({ email: 'a@gmail.com', institution_name: 'X' }, deps)
    expect(u.institution_pdl_verified).toBe(false)
    expect(u.email_domain_type).toBe('personal')
    expect(typeof u.enrichment_priority).toBe('number')
  })

  // ── False-corporate resolution (academic_domains lookup) ────────────────────────
  // Student B: submits a real institution, but the School Cleaner mis-resolves campus.ul.pt's
  // institution to up.pt, so the cross-link fails and the verdict is 'corporate'. The email's own
  // domain IS a known academic domain, so the lookup flips it back to academic.
  const lisbonLookup = async (candidates: string[]) =>
    candidates.includes('campus.ul.pt') || candidates.includes('ul.pt')
      ? { domain: 'campus.ul.pt', name: 'Universidade de Lisboa', country: 'Portugal' }
      : null

  it('flips a mis-resolved corporate verdict to academic when the email domain is a known academic domain', async () => {
    const deps = baseDeps({
      // Cleaner returns the WRONG institution/domain (up.pt) for Student B's submitted name.
      cleanSchool: async () => ({ display_name: 'University of Porto', domain: 'up.pt', type: 'university', location: { country: 'Portugal' } }),
      lookupAcademicDomain: lisbonLookup,
    })
    const u = await runPreEnrichment(
      { email: 'student.b@campus.ul.pt', institution_name: 'Faculdade de Arquitectura da Universidade de Lisboa' },
      deps,
    )
    expect(u.email_domain_type).toBe('academic')
    expect(u.institution_domain_verified).toBe('campus.ul.pt') // adopt the email's academic domain
    expect(u.institution_name_normalized).toBeNull()           // drop the cleaner's wrong institution
    expect(u.institution_country_normalized).toBe('Portugal')  // dataset country
  })

  it('does NOT flip a genuine corporate address claiming a school (anti-misuse)', async () => {
    const deps = baseDeps({
      cleanSchool: async () => ({ display_name: 'MIT', domain: 'mit.edu', type: 'university', location: { country: 'United States' } }),
      lookupAcademicDomain: lisbonLookup, // acme.com is not in the set → returns null
    })
    const u = await runPreEnrichment({ email: 'john@acme.com', institution_name: 'MIT' }, deps)
    expect(u.email_domain_type).toBe('corporate')
    expect(u.institution_name_normalized).toBe('MIT') // PDL result untouched — not nulled
  })

  it('skips the lookup entirely when no academic-domain dep is provided', async () => {
    const u = await runPreEnrichment({ email: 'a@acme.io', institution_name: 'X' }, baseDeps())
    expect(u.email_domain_type).toBe('corporate')
  })

  it('does not run the lookup for an already-academic (or personal) verdict', async () => {
    let called = false
    const deps = baseDeps({ lookupAcademicDomain: async () => { called = true; return null } })
    await runPreEnrichment({ email: 'a@mit.edu', institution_name: 'MIT' }, deps) // .edu → academic
    await runPreEnrichment({ email: 'a@gmail.com', institution_name: 'MIT' }, deps) // personal
    expect(called).toBe(false)
  })
})
