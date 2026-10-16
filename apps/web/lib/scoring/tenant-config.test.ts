/** tenant_scoring_config → ScoringConfig layering (weights from DB, never hardcoded — CLAUDE.md). */
import { describe, expect, it } from 'vitest'
import { defaultScoringConfig, scoringConfigFromRow } from './models'

describe('scoringConfigFromRow', () => {
  it('null/missing row → exact CEDS defaults (regression safety)', () => {
    expect(scoringConfigFromRow(null)).toEqual(defaultScoringConfig())
    expect(scoringConfigFromRow(undefined)).toEqual(defaultScoringConfig())
    expect(scoringConfigFromRow({})).toEqual(defaultScoringConfig())
  })

  it('a row seeded with the default values scores byte-identically to CEDS', () => {
    const row = {
      tier1_threshold: 65, tier2_threshold: 40, tier3_threshold: 20, grace_period_days: 90,
      signal_a1_weight: 35, signal_a2_weight: 20, signal_a3_weight: 20, signal_a4_weight: 10,
      signal_b1_personal_weight: 8, signal_b2_weight: 20, signal_b3_weight: 8,
      signal_c1_weight: 25, signal_c2_strong_weight: 20, signal_c2_weak_weight: 10,
      signal_c3_weight: 15, signal_c4_weight: 10,
      signal_b1_academic_exculpatory: -10, signal_c2_student_exculpatory: -15,
      signal_c3_future_exculpatory: -5, signal_c4_academic_exculpatory: -5,
      vertical_tag: 'aec',
    }
    expect(scoringConfigFromRow(row)).toEqual(defaultScoringConfig())
  })

  it('overridden columns layer over defaults; untouched fields keep defaults', () => {
    const config = scoringConfigFromRow({ signal_a1_weight: 50, tier1_threshold: 70, vertical_tag: 'design' })
    expect(config.signalA1Weight).toBe(50)
    expect(config.tier1Threshold).toBe(70)
    expect(config.verticalTag).toBe('design')
    expect(config.signalC1Weight).toBe(defaultScoringConfig().signalC1Weight)
    expect(config.strongProfessionalKeywords).toEqual(defaultScoringConfig().strongProfessionalKeywords)
  })

  it('non-numeric / null columns never poison the config (fallback per field)', () => {
    const config = scoringConfigFromRow({ signal_a1_weight: 'bogus', signal_b2_weight: null, tier2_threshold: '45' })
    expect(config.signalA1Weight).toBe(defaultScoringConfig().signalA1Weight)
    expect(config.signalB2Weight).toBe(defaultScoringConfig().signalB2Weight)
    expect(config.tier2Threshold).toBe(45) // numeric strings (PostgREST numeric) coerce fine
  })
})
