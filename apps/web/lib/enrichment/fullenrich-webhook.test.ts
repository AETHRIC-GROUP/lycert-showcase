import { describe, it, expect } from 'vitest'
import { applyFullenrichResult, resolveTimedOutPending, type ExistingEnrichment } from './fullenrich-webhook'
import type { WebhookResultItem } from './providers/fullenrich'

const pendingRow = (): ExistingEnrichment => ({
  tenant_id: 't1',
  linkedin_profile_url: 'https://linkedin.com/in/jane',
  li_current_employer_name: 'Acme',
  li_job_title: 'Engineer',
  field_provenance: { linkedin_profile_url: 'hunter', li_current_employer_name: 'hunter', li_job_title: 'hunter' },
  providers_attempted: [{ provider: 'hunter', outcome: 'partial' }],
  enrichment_provider: 'hunter',
  pending_async_provider: 'fullenrich',
})

const matchItem = (): WebhookResultItem => ({
  subscriberId: 's1',
  jobId: 'job1',
  fields: { li_education_end_date: '2024-12-31', li_job_start_date: '2023-01-01' },
  fullName: 'Jane',
  matched: true,
})

describe('applyFullenrichResult', () => {
  it('skips when there is no existing enrichment row', () => {
    expect(applyFullenrichResult(null, matchItem(), 'Jane').status).toBe('no_existing_row')
  })

  it('is idempotent: skips when the subscriber is not pending on fullenrich (replay)', () => {
    const row = pendingRow()
    row.pending_async_provider = null // already cleared by a prior delivery
    expect(applyFullenrichResult(row, matchItem(), 'Jane').status).toBe('skipped_not_pending')
  })

  it('gap-fills education + dates and flips the merged record to complete', () => {
    const res = applyFullenrichResult(pendingRow(), matchItem(), 'Jane')
    expect(res.status).toBe('applied')
    if (res.status !== 'applied') return
    // first-write-wins: hunter's identity fields untouched
    expect(res.update.linkedin_profile_url).toBe('https://linkedin.com/in/jane')
    expect(res.update.field_provenance).toMatchObject({ linkedin_profile_url: 'hunter' })
    // fullenrich filled the gaps + recorded provenance
    expect(res.update.li_education_end_date).toBe('2024-12-31')
    expect(res.update.li_job_start_date).toBe('2023-01-01')
    expect((res.update.field_provenance as Record<string, string>).li_education_end_date).toBe('fullenrich')
    // merged is now complete; pending cleared (idempotency flag)
    expect(res.update.completeness).toBe('complete')
    expect(res.update.pending_async_provider).toBeNull()
    // providers_attempted appends fullenrich
    expect(res.update.providers_attempted).toEqual([
      { provider: 'hunter', outcome: 'partial' },
      { provider: 'fullenrich', outcome: 'partial' }, // fullenrich's own fields lack identity
    ])
  })

  it('charges on a successful match and decrements async_pending', () => {
    const res = applyFullenrichResult(pendingRow(), matchItem(), 'Jane')
    if (res.status !== 'applied') throw new Error('expected applied')
    expect(res.matched).toBe(true)
    expect(res.delta).toMatchObject({
      perProvider: { fullenrich: { attempts: 1, hits: 1, cost_usd: 0.05 } },
      success: 1, miss: 0, costUsd: 0.05, asyncPending: -1,
    })
  })

  it('records a miss (no charge) when FullEnrich returns nothing, still clearing pending', () => {
    const item: WebhookResultItem = { subscriberId: 's1', jobId: 'job1', fields: {}, fullName: null, matched: false }
    const res = applyFullenrichResult(pendingRow(), item, 'Jane')
    if (res.status !== 'applied') throw new Error('expected applied')
    expect(res.matched).toBe(false)
    expect(res.update.pending_async_provider).toBeNull()
    expect(res.delta).toMatchObject({ success: 0, miss: 1, costUsd: 0, asyncPending: -1 })
    expect(res.delta.perProvider.fullenrich).toEqual({ attempts: 1, hits: 0, cost_usd: 0 })
  })
})

describe('resolveTimedOutPending', () => {
  it('clears a stuck fullenrich pending flag and records a timeout attempt', () => {
    const res = resolveTimedOutPending(pendingRow())
    expect(res).not.toBeNull()
    expect(res!.update.pending_async_provider).toBeNull()
    expect(res!.update.providers_attempted).toEqual([
      { provider: 'hunter', outcome: 'partial' },
      { provider: 'fullenrich', outcome: 'timeout' },
    ])
  })
  it('returns null when the row is not pending on fullenrich', () => {
    const row = pendingRow()
    row.pending_async_provider = null
    expect(resolveTimedOutPending(row)).toBeNull()
  })
})
