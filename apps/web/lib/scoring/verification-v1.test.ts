/**
 * V1 authoritative-enrollment scoring signal (Part 7) — override semantics + the no-op guarantee.
 * The CEDS regression (regression.test.ts) proves the 3-arg path is byte-identical; this proves the
 * 4-arg behaviour and that an `unverified` input is itself a no-op.
 */
import { describe, it, expect } from 'vitest'
import { scoreRow } from './engine'
import { defaultScoringConfig, type SubscriberRecord } from './models'
import { V1_NOT_ENROLLED_ACTION } from './verification-signal'

const REF = new Date(Date.UTC(2026, 0, 1))
const config = defaultScoringConfig()

// renewalDeltaDays -400 → A1 strong (35); liEducationEndDate 2020 → C3 (15). Base ≥ 40 (Tier 1/2).
const SUSPICIOUS: SubscriberRecord = {
  email: 'someone@bigcorp.com',
  accountName: 'Someone',
  institutionName: 'State University',
  institutionLocation: 'United States',
  accountCountry: 'United States',
  statedGraduationDate: new Date(Date.UTC(2024, 0, 1)),
  renewalDeltaDays: -400,
  proofSubmissionDate: null,
  subscriptionStartDate: null,
  subscriptionEndDate: null,
  liCurrentEmployerName: '',
  liJobEndDate: null,
  liJobTitle: '',
  liEducationEndDate: new Date(Date.UTC(2020, 0, 1)),
  liCurrentEmployerDomain: '',
}

describe('V1 authoritative-enrollment override (Part 7)', () => {
  it('base record (no verification) scores into Tier 1/2 and fires C3', () => {
    const base = scoreRow(SUSPICIOUS, config, REF)
    expect(base.totalScore).toBeGreaterThanOrEqual(config.tier2Threshold)
    expect(base.signalsFired).toMatch(/C3_/)
    expect(base.verificationApplied).toBeUndefined() // no V1 provenance on the 3-arg path
  })

  it('verified_enrolled caps suspicion strictly below Tier-2 and removes C3', () => {
    const base = scoreRow(SUSPICIOUS, config, REF)
    const enrolled = scoreRow(SUSPICIOUS, config, REF, { status: 'verified_enrolled', confidence: 'authoritative' })
    expect(enrolled.totalScore).toBeLessThanOrEqual(config.tier2Threshold - 1)
    expect(enrolled.confidenceTier).toBeGreaterThanOrEqual(3) // Watch list or Clean — never Tier 1/2
    expect(enrolled.signalsFired).not.toMatch(/C3_/) // C3 overridden by authoritative enrollment
    expect(base.signalsFired).toMatch(/C3_/)
    expect(enrolled.verificationApplied).toBe(true)
    expect(enrolled.verificationStatus).toBe('verified_enrolled')
  })

  it('semi-authoritative verified_enrolled (email-loop) also caps below Tier-2', () => {
    const enrolled = scoreRow(SUSPICIOUS, config, REF, { status: 'verified_enrolled', confidence: 'semi_authoritative' })
    expect(enrolled.totalScore).toBeLessThanOrEqual(config.tier2Threshold - 1)
  })

  it('verified_not_enrolled routes to human review WITHOUT changing the score (never auto-action)', () => {
    const base = scoreRow(SUSPICIOUS, config, REF)
    const notEnrolled = scoreRow(SUSPICIOUS, config, REF, { status: 'verified_not_enrolled', confidence: 'authoritative' })
    expect(notEnrolled.recommendedAction).toBe(V1_NOT_ENROLLED_ACTION)
    expect(notEnrolled.totalScore).toBe(base.totalScore) // inculpatory but score unchanged; human gate decides
    expect(notEnrolled.verificationApplied).toBe(true)
  })

  it('unverified / expired / absent are exact no-ops (the regression guarantee)', () => {
    const base = scoreRow(SUSPICIOUS, config, REF)
    expect(scoreRow(SUSPICIOUS, config, REF, { status: 'unverified', confidence: null })).toEqual(base)
    expect(scoreRow(SUSPICIOUS, config, REF, { status: 'verification_expired', confidence: null })).toEqual(base)
    expect(scoreRow(SUSPICIOUS, config, REF, undefined)).toEqual(base)
  })
})
