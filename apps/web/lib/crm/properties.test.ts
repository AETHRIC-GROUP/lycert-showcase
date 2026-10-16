import { describe, it, expect } from 'vitest'
import { planPropertyBootstrap, LYCERT_PROPERTIES } from './properties'

describe('planPropertyBootstrap', () => {
  it('plans to create everything on an empty portal', () => {
    const plan = planPropertyBootstrap([])
    expect(plan.toCreate).toHaveLength(LYCERT_PROPERTIES.length)
    expect(plan.conflicts).toHaveLength(0)
    expect(plan.ok).toHaveLength(0)
  })

  it('is idempotent: a second run against the result of the first creates nothing', () => {
    const existing = LYCERT_PROPERTIES.map(p => ({ name: p.name, type: p.type }))
    const plan = planPropertyBootstrap(existing)
    expect(plan.toCreate).toHaveLength(0)
    expect(plan.conflicts).toHaveLength(0)
    expect(plan.ok).toHaveLength(LYCERT_PROPERTIES.length)
  })

  it('flags a type conflict and never proposes overwriting it', () => {
    const existing = [{ name: 'lycert_estimated_graduation_date', type: 'string' }] // real type is 'date'
    const plan = planPropertyBootstrap(existing)
    expect(plan.conflicts).toEqual([{ name: 'lycert_estimated_graduation_date', expectedType: 'date', actualType: 'string' }])
    expect(plan.toCreate.find(d => d.name === 'lycert_estimated_graduation_date')).toBeUndefined()
  })

  it('handles a partial portal: some ok, some missing, one conflict', () => {
    const existing = [
      { name: 'lycert_lifecycle_stage', type: 'enumeration' }, // matches -> ok
      { name: 'lycert_conversion_score', type: 'string' },     // mismatch -> conflict (real type is number)
    ]
    const plan = planPropertyBootstrap(existing)
    expect(plan.ok).toContain('lycert_lifecycle_stage')
    expect(plan.conflicts.map(c => c.name)).toContain('lycert_conversion_score')
    expect(plan.toCreate).toHaveLength(LYCERT_PROPERTIES.length - 2)
  })

  it('every enumeration property declares a non-empty options list', () => {
    for (const def of LYCERT_PROPERTIES) {
      if (def.type === 'enumeration') expect(def.options?.length).toBeGreaterThan(0)
    }
  })
})
