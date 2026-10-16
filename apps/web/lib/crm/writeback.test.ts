import { describe, it, expect } from 'vitest'
import {
  mapLifecycleStageForCrm, estimateEducationStatus, recommendOffer, buildWritebackProperties,
  hashWritebackProperties, decideWriteback,
} from './writeback'

const NOW = new Date('2026-10-09T12:00:00Z')

describe('mapLifecycleStageForCrm', () => {
  it('maps every internal lifecycle_stage value to one of the 5 Bridge Part 6.7 options', () => {
    const allowed = new Set(['active_student', 'approaching_graduation', 'recent_graduate', 'post_graduation', 'converted'])
    const internalValues = [
      'active_student', 'approaching_graduation', 'post_graduation_unverified', 're_verification_pending',
      'converted', 'churned', 'flagged_review', 'dismissed',
    ]
    for (const v of internalValues) expect(allowed.has(mapLifecycleStageForCrm(v))).toBe(true)
  })

  it('maps the exact 1:1 cases correctly', () => {
    expect(mapLifecycleStageForCrm('active_student')).toBe('active_student')
    expect(mapLifecycleStageForCrm('approaching_graduation')).toBe('approaching_graduation')
    expect(mapLifecycleStageForCrm('converted')).toBe('converted')
  })

  it('an unknown internal value falls back to active_student rather than writing an invalid option', () => {
    expect(mapLifecycleStageForCrm('some_future_enum_value')).toBe('active_student')
  })
})

describe('estimateEducationStatus (from stated graduation date only — M1 scope)', () => {
  it('null date -> unknown', () => {
    expect(estimateEducationStatus(null, NOW)).toBe('unknown')
  })
  it('future date -> likely_enrolled', () => {
    expect(estimateEducationStatus('2027-01-01', NOW)).toBe('likely_enrolled')
  })
  it('past date -> likely_graduated', () => {
    expect(estimateEducationStatus('2025-01-01', NOW)).toBe('likely_graduated')
  })
  it('garbage date string -> unknown, never throws', () => {
    expect(estimateEducationStatus('not-a-date', NOW)).toBe('unknown')
  })
  it('never returns enrolled_confirmed or graduation_confirmed_by_student (those require a verification provider)', () => {
    for (const d of [null, '2020-01-01', '2030-01-01']) {
      const status = estimateEducationStatus(d, NOW)
      expect(['likely_enrolled', 'likely_graduated', 'unknown']).toContain(status)
    }
  })
})

describe('recommendOffer (M2 — only one real signal exists today)', () => {
  it('graduate_discount for stages at/near graduation', () => {
    for (const s of ['approaching_graduation', 'post_graduation_unverified', 're_verification_pending']) {
      expect(recommendOffer(s)).toBe('graduate_discount')
    }
  })
  it('none for everything else — startup_plan/team_plan are unreachable (no signal yet, documented not hidden)', () => {
    for (const s of ['active_student', 'converted', 'churned', 'flagged_review', 'dismissed', 'unknown_future_value']) {
      expect(recommendOffer(s)).toBe('none')
    }
  })
})

describe('buildWritebackProperties', () => {
  it('writes the M1 fields + lycert_recommended_offer, but NOT lycert_conversion_score when never scored', () => {
    const props = buildWritebackProperties({ statedGraduationDate: '2027-01-01', lifecycleStage: 'active_student', totalScore: null }, NOW)
    expect(Object.keys(props).sort()).toEqual([
      'lycert_education_status', 'lycert_estimated_graduation_date', 'lycert_last_synced',
      'lycert_lifecycle_stage', 'lycert_recommended_offer',
    ])
    expect(props.lycert_recommended_offer).toBe('none')
  })
  it('includes lycert_conversion_score once a score exists', () => {
    const props = buildWritebackProperties({ statedGraduationDate: '2027-01-01', lifecycleStage: 'approaching_graduation', totalScore: 72 }, NOW)
    expect(props.lycert_conversion_score).toBe('72')
    expect(props.lycert_recommended_offer).toBe('graduate_discount')
  })
  it('omits lycert_estimated_graduation_date when there is no stated date (never writes an empty date)', () => {
    const props = buildWritebackProperties({ statedGraduationDate: null, lifecycleStage: 'active_student', totalScore: null }, NOW)
    expect(props.lycert_estimated_graduation_date).toBeUndefined()
    expect(props.lycert_education_status).toBe('unknown')
  })
  it('never writes lycert_personalization_line — not built, flagged as a gap, not faked (DECISIONS.md 2026-10-12)', () => {
    const props = buildWritebackProperties({ statedGraduationDate: '2027-01-01', lifecycleStage: 'active_student', totalScore: 50 }, NOW)
    expect(props.lycert_personalization_line).toBeUndefined()
  })
})

describe('hashWritebackProperties', () => {
  it('is stable under key order', () => {
    const a = hashWritebackProperties({ x: '1', y: '2' })
    const b = hashWritebackProperties({ y: '2', x: '1' })
    expect(a).toBe(b)
  })
  it('differs when a value differs', () => {
    expect(hashWritebackProperties({ x: '1' })).not.toBe(hashWritebackProperties({ x: '2' }))
  })
})

describe('decideWriteback', () => {
  const sub = { statedGraduationDate: '2027-01-01', lifecycleStage: 'active_student', totalScore: null }

  it('writes when there is no previous hash', () => {
    expect(decideWriteback(sub, NOW, null).shouldWrite).toBe(true)
  })

  it('does NOT write again when nothing but the clock changed (last_synced excluded from the diff)', () => {
    const first = decideWriteback(sub, NOW, null)
    const later = decideWriteback(sub, new Date('2026-10-10T00:00:00Z'), first.hash)
    expect(later.shouldWrite).toBe(false)
  })

  it('writes again when the lifecycle stage actually changes', () => {
    const first = decideWriteback(sub, NOW, null)
    const changed = decideWriteback({ ...sub, lifecycleStage: 'converted' }, NOW, first.hash)
    expect(changed.shouldWrite).toBe(true)
  })

  it('writes again when education status flips from likely_enrolled to likely_graduated as time passes', () => {
    const first = decideWriteback(sub, new Date('2026-06-01T00:00:00Z'), null) // before grad date -> likely_enrolled
    const after = decideWriteback(sub, new Date('2027-06-01T00:00:00Z'), first.hash) // after -> likely_graduated
    expect(after.shouldWrite).toBe(true)
  })

  it('writes again when a score newly appears or changes (M2 — this is the whole point of writebackOne existing)', () => {
    const first = decideWriteback(sub, NOW, null)
    const scored = decideWriteback({ ...sub, totalScore: 40 }, NOW, first.hash)
    expect(scored.shouldWrite).toBe(true)
    const rescored = decideWriteback({ ...sub, totalScore: 85 }, NOW, scored.hash)
    expect(rescored.shouldWrite).toBe(true)
  })
})
