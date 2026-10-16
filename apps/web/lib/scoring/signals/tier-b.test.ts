/** B3 country-mismatch tests — Location-Cleaner-normalised fields preferred, raw+alias fallback. */
import { describe, it, expect } from 'vitest'
import { scoreB1, scoreB3 } from './tier-b'
import { defaultScoringConfig, type SubscriberRecord } from '../models'

const cfg = defaultScoringConfig()

function rec(over: Partial<SubscriberRecord>): SubscriberRecord {
  return {
    email: '', accountName: '', institutionName: '', institutionLocation: '', accountCountry: '',
    statedGraduationDate: null, renewalDeltaDays: null, proofSubmissionDate: null,
    subscriptionStartDate: null, subscriptionEndDate: null, liCurrentEmployerName: '',
    liJobEndDate: null, liJobTitle: '', liEducationEndDate: null, liCurrentEmployerDomain: '',
    ...over,
  }
}

describe('scoreB1 — institution-domain cross-link', () => {
  it('cross-links a subdomain of the verified institution domain → academic exculpatory', () => {
    const [pts, key] = scoreB1(rec({
      email: 'student.a@edu.cegepgarneau.ca', institutionDomainVerified: 'cegepgarneau.ca',
    }), cfg)
    expect(pts).toBe(cfg.signalB1AcademicExculpatory)
    expect(key).toBe('B1_academic_email_exculpatory')
  })

  it('does not cross-link a suffix collision (evilcegepgarneau.ca)', () => {
    const [pts, key] = scoreB1(rec({
      email: 'a@evilcegepgarneau.ca', institutionDomainVerified: 'cegepgarneau.ca',
    }), cfg)
    expect(pts).toBe(0)
    expect(key).toBe('')
  })

  it('no verified domain → unchanged CEDS behaviour (corporate scores 0)', () => {
    const [pts] = scoreB1(rec({ email: 'a@acme.io' }), cfg)
    expect(pts).toBe(0)
  })
})

describe('scoreB3 — Location-Cleaner-first country comparison', () => {
  it('uses normalised fields when present: same country → no fire', () => {
    const [pts] = scoreB3(rec({
      institutionCountryNormalized: 'United States', accountCountryNormalized: 'United States',
    }), cfg)
    expect(pts).toBe(0)
  })

  it('uses normalised fields when present: different country → fires', () => {
    const [pts, key] = scoreB3(rec({
      institutionCountryNormalized: 'Germany', accountCountryNormalized: 'France',
    }), cfg)
    expect(pts).toBe(cfg.signalB3Weight)
    expect(key).toBe('B3_country_mismatch')
  })

  it('normalised field beats a raw alias gap (Deutschland vs Germany → no false mismatch)', () => {
    // Raw-only would extract "deutschland" (not in aliases) vs "germany" → false fire.
    // With both normalised to Germany, no fire.
    const [pts] = scoreB3(rec({
      institutionCountryNormalized: 'Germany', accountCountryNormalized: 'Germany',
      institutionLocation: 'Berlin, Deutschland', accountCountry: 'Munich, Germany',
    }), cfg)
    expect(pts).toBe(0)
  })

  it('falls back to raw + alias when normalised fields absent (USA == United States → no fire)', () => {
    const [pts] = scoreB3(rec({
      institutionLocation: 'Haverford, USA',
      accountCountry: '310 Westview Dr, Missoula, United States',
    }), cfg)
    expect(pts).toBe(0) // COUNTRY_ALIASES resolves usa → united states
  })

  it('falls back to raw + alias: genuine mismatch still fires (USA vs UK)', () => {
    const [pts, key] = scoreB3(rec({
      institutionLocation: 'New York, USA', accountCountry: 'London, UK',
    }), cfg)
    expect(pts).toBe(cfg.signalB3Weight)
    expect(key).toBe('B3_country_mismatch')
  })

  it('no country on either side → no fire', () => {
    expect(scoreB3(rec({ institutionLocation: 'Berlin, Germany' }), cfg)[0]).toBe(0)
  })
})
