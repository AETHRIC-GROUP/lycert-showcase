/** Cascade tests — mirror test_load_cascade + test_waterfall_orchestrator. */
import { describe, it, expect } from 'vitest'
import { buildCascade, runWaterfall, type CascadeStep } from './cascade'
import { makeResult, ProviderOutcome, type EnrichmentProvider, type CanonicalFields } from './providers/base'

const COMPLETE: CanonicalFields = { linkedin_profile_url: 'x', li_job_start_date: '2024-02-01', li_education_end_date: '2023-12-31' }
const PARTIAL: CanonicalFields = { linkedin_profile_url: 'x', li_current_employer_name: 'Gensler', li_job_title: 'Architect' }

function stub(key: string, outcome: ProviderOutcome, fields: CanonicalFields, calls: string[], mode: 'sync' | 'async' = 'sync', asyncRef?: string): EnrichmentProvider {
  return {
    providerKey: key,
    executionMode: mode,
    async enrich() {
      calls.push(key)
      return makeResult(key, outcome, { fields, charged: Object.keys(fields).length > 0, costUsd: 0.03, fullName: 'Jane Smith', asyncReference: asyncRef ?? null })
    },
  }
}

const PROVIDERS = (providerRows: any[]) => providerRows

describe('buildCascade', () => {
  const rows = [
    { provider_key: 'zerobounce', provider_type: 'validation', execution_mode: 'sync', enabled: true, default_position: null },
    { provider_key: 'hunter', provider_type: 'enrichment', execution_mode: 'sync', enabled: true, default_position: 1 },
    { provider_key: 'reversecontact', provider_type: 'enrichment', execution_mode: 'sync', enabled: true, default_position: 2 },
    { provider_key: 'datagma', provider_type: 'enrichment', execution_mode: 'sync', enabled: true, default_position: 3 },
    { provider_key: 'pdl', provider_type: 'enrichment', execution_mode: 'sync', enabled: true, default_position: 4 },
    { provider_key: 'fullenrich', provider_type: 'enrichment', execution_mode: 'async', enabled: true, default_position: 5 },
    { provider_key: 'apollo', provider_type: 'enrichment', execution_mode: 'sync', enabled: false, default_position: 6 },
  ]
  it('default order excludes validation + disabled', () => {
    expect(buildCascade(PROVIDERS(rows)).map(s => s.providerKey)).toEqual(['hunter', 'reversecontact', 'datagma', 'pdl', 'fullenrich'])
  })
  it('preserves async mode', () => {
    expect(buildCascade(PROVIDERS(rows)).find(s => s.providerKey === 'fullenrich')!.executionMode).toBe('async')
  })
  it('tenant override reorders + disables', () => {
    const cascade = buildCascade(PROVIDERS(rows), [
      { provider_key: 'datagma', position: 1, enabled: true },
      { provider_key: 'hunter', position: 2, enabled: true },
      { provider_key: 'pdl', position: 4, enabled: false },
    ])
    const keys = cascade.map(s => s.providerKey)
    expect(keys[0]).toBe('datagma')
    expect(keys[1]).toBe('hunter')
    expect(keys).not.toContain('pdl')
  })
  it('drops unknown keys + null position', () => {
    expect(buildCascade([
      { provider_key: 'hunter', provider_type: 'enrichment', execution_mode: 'sync', enabled: true, default_position: 1 },
      { provider_key: 'ghost', provider_type: 'enrichment', execution_mode: 'sync', enabled: true, default_position: 2 },
      { provider_key: 'datagma', provider_type: 'enrichment', execution_mode: 'sync', enabled: true, default_position: null },
    ]).map(s => s.providerKey)).toEqual(['hunter'])
  })
})

const SYNC = (key: string): CascadeStep => ({ providerKey: key, executionMode: 'sync', position: 1 })
const ASYNC = (key: string): CascadeStep => ({ providerKey: key, executionMode: 'async', position: 5 })
const input = (priority = 50) => ({ email: 'a@b.com', name: 'Jane Smith', subscriberId: 's1', enrichmentPriority: priority })

describe('runWaterfall', () => {
  it('stops on COMPLETE (later providers not called)', async () => {
    const calls: string[] = []
    const provs: Record<string, EnrichmentProvider> = {
      hunter: stub('hunter', ProviderOutcome.PARTIAL, PARTIAL, calls),
      reversecontact: stub('reversecontact', ProviderOutcome.COMPLETE, COMPLETE, calls),
      datagma: stub('datagma', ProviderOutcome.COMPLETE, COMPLETE, calls),
    }
    const res = await runWaterfall(input(), {
      cascade: [SYNC('hunter'), SYNC('reversecontact'), SYNC('datagma')],
      getProvider: k => provs[k] ?? null, validationBlocks: false,
    })
    expect(res.completeness).toBe(ProviderOutcome.COMPLETE)
    expect(calls).toEqual(['hunter', 'reversecontact'])
  })

  it('continues on PARTIAL', async () => {
    const calls: string[] = []
    const provs: Record<string, EnrichmentProvider> = {
      hunter: stub('hunter', ProviderOutcome.PARTIAL, PARTIAL, calls),
      reversecontact: stub('reversecontact', ProviderOutcome.PARTIAL, { li_employer_industry: 'AEC' }, calls),
    }
    const res = await runWaterfall(input(), { cascade: [SYNC('hunter'), SYNC('reversecontact')], getProvider: k => provs[k] ?? null, validationBlocks: false })
    expect(res.completeness).toBe(ProviderOutcome.PARTIAL)
    expect(calls).toEqual(['hunter', 'reversecontact'])
  })

  it('Stage 0 block → no providers called', async () => {
    const calls: string[] = []
    const res = await runWaterfall(input(), {
      cascade: [SYNC('hunter')], getProvider: () => stub('hunter', ProviderOutcome.PARTIAL, PARTIAL, calls), validationBlocks: true,
    })
    expect(res.blocked).toBe(true)
    expect(calls).toEqual([])
  })

  it('async handoff fires at priority >= 40, skipped below', async () => {
    const mk = (priority: number) => {
      const calls: string[] = []
      const provs: Record<string, EnrichmentProvider> = {
        hunter: stub('hunter', ProviderOutcome.MISS, {}, calls),
        fullenrich: stub('fullenrich', ProviderOutcome.PENDING, {}, calls, 'async', 'enr-1'),
      }
      return { calls, opts: { cascade: [SYNC('hunter'), ASYNC('fullenrich')], getProvider: (k: string) => provs[k] ?? null, validationBlocks: false } }
    }
    const hi = mk(50); const rHi = await runWaterfall(input(50), hi.opts)
    expect(rHi.pendingProvider).toBe('fullenrich')
    expect(rHi.pendingReference).toBe('enr-1') // async job id captured for the poll fallback
    expect(hi.calls).toContain('fullenrich')

    const lo = mk(30); const rLo = await runWaterfall(input(30), lo.opts)
    expect(rLo.pendingProvider).toBeNull()
    expect(rLo.pendingReference).toBeNull()
    expect(lo.calls).not.toContain('fullenrich')
  })

  it('allowAsync:false skips the paid async sweep entirely (not even attempted → retryable)', async () => {
    const calls: string[] = []
    const provs: Record<string, EnrichmentProvider> = {
      hunter: stub('hunter', ProviderOutcome.MISS, {}, calls),
      fullenrich: stub('fullenrich', ProviderOutcome.PENDING, {}, calls, 'async', 'enr-1'),
    }
    const r = await runWaterfall(input(50), {
      cascade: [SYNC('hunter'), ASYNC('fullenrich')], getProvider: k => provs[k] ?? null,
      validationBlocks: false, allowAsync: false,
    })
    expect(calls).not.toContain('fullenrich') // never submitted → no wasted credit
    expect(r.pendingProvider).toBeNull()
    expect(r.attempted.map(a => a.provider)).not.toContain('fullenrich') // retryable on a later healthy run
  })

  it('checkpoint: a provider already attempted is not re-called (no double-charge on retry)', async () => {
    const calls: string[] = []
    const provs: Record<string, EnrichmentProvider> = {
      hunter: stub('hunter', ProviderOutcome.PARTIAL, PARTIAL, calls),
      reversecontact: stub('reversecontact', ProviderOutcome.PARTIAL, { li_employer_industry: 'AEC' }, calls),
    }
    const res = await runWaterfall(input(), {
      cascade: [SYNC('hunter'), SYNC('reversecontact')], getProvider: k => provs[k] ?? null, validationBlocks: false,
      seedAttempted: [{ provider: 'hunter', outcome: 'partial' }],
      seedMerged: { ...PARTIAL }, seedProvenance: { li_job_title: 'hunter' },
    })
    expect(calls).toEqual(['reversecontact']) // hunter skipped
    expect(res.attempted.map(a => a.provider)).toContain('reversecontact')
  })
})
