/** Merge engine tests — Part 5. Mirrors apps/api/tests/enrichment/test_merge_rules.py. */
import { describe, it, expect } from 'vitest'
import { mergeFields, sameEmployer, namesOverlap, type MergeStatus } from './merge'
import type { CanonicalFields } from './providers/base'

function r(providerKey: string, fields: CanonicalFields, fullName: string | null = null) {
  return { providerKey, fields, fullName }
}

function run(provider: string, fields: CanonicalFields, fullName: string | null, merged: CanonicalFields, prov: Record<string, string>, name: string | null = 'Jane Smith'): MergeStatus {
  return mergeFields(merged, prov, r(provider, fields, fullName), name)
}

describe('mergeFields — Part 5 rules', () => {
  it('first-written wins', () => {
    const m: CanonicalFields = {}, p: Record<string, string> = {}
    run('hunter', { li_job_title: 'Junior Architect' }, null, m, p)
    run('reversecontact', { li_job_title: 'Senior Architect' }, null, m, p)
    expect(m.li_job_title).toBe('Junior Architect')
    expect(p.li_job_title).toBe('hunter')
  })

  it('later provider fills gaps only', () => {
    const m: CanonicalFields = {}, p: Record<string, string> = {}
    run('hunter', { li_job_title: 'Architect' }, null, m, p)
    run('reversecontact', { li_education_end_date: '2023-12-31', li_education_institution: 'Stuttgart' }, null, m, p)
    expect(m.li_job_title).toBe('Architect')
    expect(m.li_education_end_date).toBe('2023-12-31')
    expect(p.li_education_end_date).toBe('reversecontact')
  })

  it('PDL education overrides earlier provider', () => {
    const m: CanonicalFields = {}, p: Record<string, string> = {}
    run('reversecontact', { li_education_institution: 'Online U', li_education_end_date: '2020-12-31' }, null, m, p)
    run('pdl', { li_education_institution: 'University of Stuttgart', li_education_end_date: '2023-12-31' }, null, m, p)
    expect(m.li_education_institution).toBe('University of Stuttgart')
    expect(m.li_education_end_date).toBe('2023-12-31')
    expect(p.li_education_end_date).toBe('pdl')
  })

  it('PDL does not override non-education fields', () => {
    const m: CanonicalFields = {}, p: Record<string, string> = {}
    run('hunter', { li_job_title: 'Architect' }, null, m, p)
    run('pdl', { li_job_title: 'Designer' }, null, m, p)
    expect(m.li_job_title).toBe('Architect')
    expect(p.li_job_title).toBe('hunter')
  })

  it('same-employer date completion', () => {
    const m: CanonicalFields = {}, p: Record<string, string> = {}
    run('hunter', { li_current_employer_name: 'Gensler', li_job_title: 'Architect' }, null, m, p)
    run('reversecontact', { li_current_employer_name: 'Gensler GmbH', li_job_start_date: '2024-02-01' }, null, m, p)
    expect(m.li_current_employer_name).toBe('Gensler')
    expect(m.li_job_start_date).toBe('2024-02-01')
    expect(p.li_current_employer_name).toBe('hunter')
    expect(p.li_job_start_date).toBe('reversecontact')
  })

  it('different employer replaces the whole block', () => {
    const m: CanonicalFields = {}, p: Record<string, string> = {}
    run('hunter', { li_current_employer_name: 'OldCo', li_current_employer_domain: 'oldco.com', li_job_title: 'Intern' }, null, m, p)
    run('datagma', { li_current_employer_name: 'NewCo', li_current_employer_domain: 'newco.com', li_job_title: 'Architect', li_job_start_date: '2024-01-01' }, null, m, p)
    expect(m.li_current_employer_name).toBe('NewCo')
    expect(m.li_current_employer_domain).toBe('newco.com')
    expect(m.li_job_title).toBe('Architect')
    expect(m.li_job_start_date).toBe('2024-01-01')
    expect(p.li_current_employer_name).toBe('datagma')
  })

  it('education survives different-employer replacement', () => {
    const m: CanonicalFields = {}, p: Record<string, string> = {}
    run('reversecontact', { li_current_employer_name: 'OldCo', li_education_end_date: '2023-12-31' }, null, m, p)
    run('datagma', { li_current_employer_name: 'NewCo' }, null, m, p)
    expect(m.li_current_employer_name).toBe('NewCo')
    expect(m.li_education_end_date).toBe('2023-12-31')
    expect(p.li_education_end_date).toBe('reversecontact')
  })

  it('wrong-person guard discards result', () => {
    const m: CanonicalFields = { li_job_title: 'Architect' }, p: Record<string, string> = { li_job_title: 'hunter' }
    const status = run('reversecontact', { li_job_title: 'CEO', li_current_employer_name: 'Wrong' }, 'Bob Jones', m, p, 'Jane Smith')
    expect(status).toBe('mismatch')
    expect(m).toEqual({ li_job_title: 'Architect' })
  })

  it('name overlap allows merge', () => {
    const m: CanonicalFields = {}, p: Record<string, string> = {}
    const status = run('reversecontact', { li_job_title: 'Architect' }, 'Jane A. Smith', m, p, 'Jane Smith')
    expect(status).toBe('merged')
    expect(m.li_job_title).toBe('Architect')
  })

  it('missing names never treated as mismatch', () => {
    expect(namesOverlap(null, 'Bob Jones')).toBe(true)
    expect(namesOverlap('Jane Smith', null)).toBe(true)
  })

  it('sameEmployer helper', () => {
    expect(sameEmployer('Gensler', 'Gensler GmbH')).toBe(true)
    expect(sameEmployer('Gensler Inc.', 'gensler')).toBe(true)
    expect(sameEmployer('Gensler', 'Foster + Partners')).toBe(false)
  })

  it('empty result is a no-op', () => {
    const m: CanonicalFields = {}, p: Record<string, string> = {}
    expect(run('hunter', {}, null, m, p)).toBe('empty')
    expect(m).toEqual({})
  })
})
