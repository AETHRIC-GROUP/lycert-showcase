/** applyFullenrichItem IO — regression guard that the upsert carries tenant_id (NOT NULL on
 * subscriber_enrichment; upsert = INSERT...ON CONFLICT, so omitting it fails before the conflict
 * resolves). Fake Supabase client, no network. */
import { describe, it, expect } from 'vitest'
import { applyFullenrichItem } from './fullenrich-apply'
import type { WebhookResultItem } from './providers/fullenrich'

function fakeDb(existing: Record<string, unknown> | null, sub: { name: string | null }, cap: Record<string, any>) {
  return {
    from(table: string) {
      const b: any = {
        select() { return b },
        eq() { return b },
        async maybeSingle() { return { data: table === 'subscribers' ? sub : existing } },
        async upsert(payload: Record<string, unknown>) { cap.upsert = payload; return { error: null } },
      }
      return b
    },
    async rpc(fn: string, args: Record<string, unknown>) { (cap.rpc ??= []).push({ fn, args }); return { data: [1], error: null } },
  } as never
}

const item: WebhookResultItem = {
  subscriberId: 's1', jobId: 'job1',
  fields: { linkedin_profile_url: 'https://linkedin.com/in/x' },
  fullName: 'Jane Smith', matched: true,
}

describe('applyFullenrichItem', () => {
  it('upsert includes tenant_id (NOT NULL regression) and applies a pending match', async () => {
    const cap: Record<string, any> = {}
    const existing = { tenant_id: 't1', pending_async_provider: 'fullenrich', field_provenance: {}, providers_attempted: [] }
    const r = await applyFullenrichItem(fakeDb(existing, { name: 'Jane Smith' }, cap), item)
    expect(r.applied).toBe(true)
    expect(cap.upsert.tenant_id).toBe('t1')
    expect(cap.upsert.subscriber_id).toBe('s1')
    expect(cap.upsert.pending_async_provider).toBeNull() // idempotency flag cleared
    // job stats accumulated + scoring re-enqueued
    expect((cap.rpc ?? []).some((c: any) => c.fn === 'q_job_accumulate')).toBe(true)
    expect((cap.rpc ?? []).some((c: any) => c.fn === 'q_send')).toBe(true)
  })

  it('skips (no upsert) when the subscriber is no longer pending on fullenrich (idempotent)', async () => {
    const cap: Record<string, any> = {}
    const existing = { tenant_id: 't1', pending_async_provider: null, field_provenance: {}, providers_attempted: [] }
    const r = await applyFullenrichItem(fakeDb(existing, { name: 'Jane Smith' }, cap), item)
    expect(r).toEqual({ applied: false, matched: false, skipped: true })
    expect(cap.upsert).toBeUndefined()
  })
})
