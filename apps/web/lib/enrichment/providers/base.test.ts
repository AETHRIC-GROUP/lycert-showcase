/** classifyCompleteness + stripToCanonical tests (Part 2.3 / Part 5 rule 6). */
import { describe, it, expect } from 'vitest'
import { classifyCompleteness, stripToCanonical, ProviderOutcome } from './base'

describe('classifyCompleteness', () => {
  it('MISS when nothing usable', () => {
    expect(classifyCompleteness({})).toBe(ProviderOutcome.MISS)
    expect(classifyCompleteness({ li_job_title: null })).toBe(ProviderOutcome.MISS)
  })

  it('COMPLETE needs identity + employment dates + education', () => {
    expect(classifyCompleteness({
      linkedin_profile_url: 'x', li_job_start_date: '2024-02-01', li_education_end_date: '2023-12-31',
    })).toBe(ProviderOutcome.COMPLETE)
    expect(classifyCompleteness({
      li_current_employer_name: 'Gensler', li_job_title: 'Architect',
      li_job_start_date: '2024-02-01', li_education_end_date: '2023-12-31',
    })).toBe(ProviderOutcome.COMPLETE)
  })

  it('PARTIAL when missing dates or education', () => {
    expect(classifyCompleteness({ linkedin_profile_url: 'x', li_job_title: 'Architect' })).toBe(ProviderOutcome.PARTIAL)
    expect(classifyCompleteness({
      linkedin_profile_url: 'x', li_job_start_date: '2024-02-01',
    })).toBe(ProviderOutcome.PARTIAL) // no education
  })

  it('identity needs employer AND title (employer alone is partial)', () => {
    expect(classifyCompleteness({ li_current_employer_name: 'Gensler' })).toBe(ProviderOutcome.PARTIAL)
  })
})

describe('stripToCanonical', () => {
  it('keeps only canonical non-null fields', () => {
    expect(stripToCanonical({
      li_job_title: 'Architect', gender: 'female', phone: '+49', li_country: null, foo: 'bar',
    })).toEqual({ li_job_title: 'Architect' })
  })
})
