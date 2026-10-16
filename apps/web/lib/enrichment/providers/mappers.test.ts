/** Canonical mapper tests — mirror the Python per-provider mapper test files. */
import { describe, it, expect } from 'vitest'
import {
  mapHunterPerson, mapReverseContactPerson, mapDatagmaPerson, mapFullenrichProfile, mapPdlPerson, mapApolloPerson,
} from './mappers'
import { classifyCompleteness, ProviderOutcome } from './base'

describe('mapHunterPerson', () => {
  const full = {
    name: { fullName: 'Jane Smith' }, geo: { country: 'DE' },
    employment: { domain: 'gensler.com', name: 'Gensler', title: 'Junior Architect', seniority: 'junior' },
    linkedin: { handle: 'in/janesmith' },
  }
  it('maps employment + linkedin, always PARTIAL (no edu/dates)', () => {
    const f = mapHunterPerson(full)
    expect(f.li_current_employer_name).toBe('Gensler')
    expect(f.li_job_title).toBe('Junior Architect')
    expect(f.li_job_title_levels).toEqual(['junior'])
    expect(f.linkedin_profile_url).toBe('https://linkedin.com/in/janesmith')
    expect(f.li_country).toBe('DE')
    expect(classifyCompleteness(f)).toBe(ProviderOutcome.PARTIAL)
  })
  it('no-match → empty → MISS', () => {
    expect(mapHunterPerson({})).toEqual({})
    expect(classifyCompleteness(mapHunterPerson({}))).toBe(ProviderOutcome.MISS)
  })
})

describe('mapReverseContactPerson', () => {
  const full = {
    person: {
      linkedInUrl: 'https://linkedin.com/in/janesmith', location: 'Berlin, Germany',
      positions: { positionHistory: [
        { title: 'Junior Architect', companyName: 'Gensler', startEndDate: { start: { month: 2, year: 2024 }, end: null } },
      ] },
      schools: { educationHistory: [
        { schoolName: 'University of Stuttgart', startEndDate: { start: { year: 2018 }, end: { year: 2023 } } },
      ] },
    },
    company: { name: 'Gensler', websiteUrl: 'gensler.com', industry: 'Architecture', employeeCount: 6000 },
  }
  it('full → COMPLETE with correct fields', () => {
    const f = mapReverseContactPerson(full)
    expect(f.li_job_title).toBe('Junior Architect')
    expect(f.li_current_employer_domain).toBe('gensler.com')
    expect(f.li_employer_size).toBe('5001-10000')
    expect(f.li_job_start_date).toBe('2024-02-01')
    expect(f.li_job_end_date).toBeUndefined()
    expect(f.li_education_end_date).toBe('2023-12-31')
    expect(f.li_city).toBe('Berlin')
    expect(f.li_country).toBe('Germany')
    expect(classifyCompleteness(f)).toBe(ProviderOutcome.COMPLETE)
  })
  it('missing education → PARTIAL', () => {
    const body = { ...full, person: { ...full.person, schools: { educationHistory: [] } } }
    expect(classifyCompleteness(mapReverseContactPerson(body))).toBe(ProviderOutcome.PARTIAL)
  })
  it('year-only start → January', () => {
    const body = { ...full, person: { ...full.person, positions: { positionHistory: [
      { title: 'X', companyName: 'Gensler', startEndDate: { start: { year: 2024 }, end: null } }] } } }
    expect(mapReverseContactPerson(body).li_job_start_date).toBe('2024-01-01')
  })
  it('no-match → empty', () => {
    expect(mapReverseContactPerson({ success: false })).toEqual({})
  })
})

describe('mapDatagmaPerson', () => {
  const full = {
    person: {
      basic: { title: 'Junior Architect', linkedInUrl: 'https://linkedin.com/in/janesmith', location: 'Berlin, Germany' },
      details: {
        positions: { positionHistory: [{ title: 'Junior Architect', companyName: 'Gensler', startEndDate: { start: { month: 3, year: 2024 }, end: null } }] },
        schools: { educationHistory: [{ schoolName: 'University of Stuttgart', startEndDate: { start: { year: 2018 }, end: { year: 2023 } } }] },
      },
    },
    company: { basic: { name: 'Gensler', website: 'gensler.com', size: '5001-10000', industry: 'Architecture' } },
  }
  it('full → COMPLETE', () => {
    const f = mapDatagmaPerson(full)
    expect(f.li_job_start_date).toBe('2024-03-01')
    expect(f.li_education_end_date).toBe('2023-12-31')
    expect(f.li_employer_size).toBe('5001-10000')
    expect(classifyCompleteness(f)).toBe(ProviderOutcome.COMPLETE)
  })
  it('no-match → empty', () => {
    expect(mapDatagmaPerson({})).toEqual({})
  })
})

describe('mapFullenrichProfile', () => {
  // Hand-built from the documented reverse-email `profile` schema (docs.fullenrich.com, 2026-06-21).
  const profile = {
    full_name: 'Jane Smith',
    social_profiles: { professional_network: { url: 'https://www.linkedin.com/in/janesmith/' } },
    employment: {
      current: { title: 'Architect', company: { name: 'Gensler', domain: 'gensler.com' }, is_current: true, start_at: '2023-02-01' },
      all: [{ title: 'Architect', company: { name: 'Gensler', domain: 'gensler.com' }, is_current: true, start_at: '2023-02-01' }],
    },
    educations: [
      { school_name: 'Old School', degree: 'Cert', start_at: '2014', end_at: '2016' },
      { school_name: 'University of Stuttgart', degree: 'B.Arch', start_at: '2018', end_at: '2023' },
    ],
    location: { country: 'Germany', region: 'Baden-Württemberg', city: 'Berlin' },
  }
  it('maps the real profile shape (LinkedIn, current employment, latest education, location)', () => {
    const f = mapFullenrichProfile(profile)
    expect(f.linkedin_profile_url).toBe('https://www.linkedin.com/in/janesmith/')
    expect(f.li_job_title).toBe('Architect')
    expect(f.li_current_employer_name).toBe('Gensler')
    expect(f.li_current_employer_domain).toBe('gensler.com')
    expect(f.li_job_start_date).toBe('2023-02-01')
    expect(f.li_job_end_date).toBeUndefined() // is_current → no end date
    expect(f.li_education_institution).toBe('University of Stuttgart') // latest by end_at
    expect(f.li_education_end_date).toBe('2023-12-31') // year → Dec 31 (PDL/edu convention)
    expect(f.li_country).toBe('Germany')
    expect(f.li_city).toBe('Berlin')
    expect(classifyCompleteness(f)).toBe(ProviderOutcome.COMPLETE)
  })
  it('falls back to employment.all when current is absent', () => {
    const f = mapFullenrichProfile({ employment: { all: [{ title: 'Designer', company: { name: 'Acme' }, is_current: true }] } })
    expect(f.li_job_title).toBe('Designer')
    expect(f.li_current_employer_name).toBe('Acme')
  })
  it('does NOT extract phones or contact_info emails (GDPR)', () => {
    const f = mapFullenrichProfile(profile)
    expect(JSON.stringify(f)).not.toMatch(/phone|email/i)
  })
  it('no profile data → empty', () => {
    expect(mapFullenrichProfile({})).toEqual({})
  })
})

describe('mapPdlPerson', () => {
  const data = {
    id: 'pdl-1', linkedin_url: 'linkedin.com/in/jane', job_title: 'Architect', job_company_name: 'Gensler',
    job_company_website: 'gensler.com', job_company_size: '5001-10000', job_start_date: '2024-02',
    location_country: 'germany', location_locality: 'berlin', skills: ['a', 'b'],
    experience: [{ is_primary: true, end_date: null }],
    education: [{ school: { name: 'University of Stuttgart' }, end_date: '2023' }],
  }
  it('maps fields incl year-only education → Dec 31', () => {
    const f = mapPdlPerson(data, 8)
    expect(f.pdl_person_id).toBe('pdl-1')
    expect(f.pdl_likelihood_score).toBe(8)
    expect(f.li_job_start_date).toBe('2024-02-01')
    expect(f.li_education_end_date).toBe('2023-12-31')
    expect(f.li_education_institution).toBe('University of Stuttgart')
    expect(f.li_city).toBe('berlin')
    expect(classifyCompleteness(f)).toBe(ProviderOutcome.COMPLETE)
  })
})

describe('mapApolloPerson', () => {
  it('maps employer, no education (PARTIAL)', () => {
    const f = mapApolloPerson({ linkedin_url: 'x', title: 'Architect', organization: { name: 'Gensler', website_url: 'gensler.com', estimated_num_employees: 30 }, employment_history: [{ current: true, start_date: '2024-02-01' }] })
    expect(f.li_employer_size).toBe('11-50')
    expect(f.li_education_end_date).toBeUndefined()
    expect(classifyCompleteness(f)).toBe(ProviderOutcome.PARTIAL)
  })
})
