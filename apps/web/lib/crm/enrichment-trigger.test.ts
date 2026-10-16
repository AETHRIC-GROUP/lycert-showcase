import { describe, it, expect } from 'vitest'
import { shouldAutoTriggerEnrichment } from './enrichment-trigger'

describe('shouldAutoTriggerEnrichment', () => {
  it('never triggers for a subscriber already enriched before (the one-shot safeguard)', () => {
    expect(shouldAutoTriggerEnrichment({
      lifecycleStage: 'approaching_graduation', confidenceTier: 1, lastEnrichedAt: '2026-01-01T00:00:00Z',
    })).toBe(false)
  })

  it('triggers for a never-enriched subscriber approaching/past graduation', () => {
    for (const stage of ['approaching_graduation', 'post_graduation_unverified', 're_verification_pending']) {
      expect(shouldAutoTriggerEnrichment({ lifecycleStage: stage, confidenceTier: null, lastEnrichedAt: null })).toBe(true)
    }
  })

  it('triggers for a never-enriched subscriber flagged by score, regardless of lifecycle stage', () => {
    expect(shouldAutoTriggerEnrichment({ lifecycleStage: 'active_student', confidenceTier: 1, lastEnrichedAt: null })).toBe(true)
  })

  it('does NOT trigger for confidence_tier 0 (Likely Clean) with no qualifying lifecycle stage', () => {
    expect(shouldAutoTriggerEnrichment({ lifecycleStage: 'active_student', confidenceTier: 0, lastEnrichedAt: null })).toBe(false)
  })

  it('does NOT trigger for an unscored, not-yet-approaching active student', () => {
    expect(shouldAutoTriggerEnrichment({ lifecycleStage: 'active_student', confidenceTier: null, lastEnrichedAt: null })).toBe(false)
  })
})
