/** Worker orchestration tests — retry / checkpoint / DLQ / persist-before-archive semantics,
 * exercised against fake IO (no Supabase, no network). */
import { describe, it, expect } from 'vitest'
import {
  processEnrichmentChunk, processScoringChunk, buildEnrichmentRow, jobDeltaFromResult, buildRecordFromDb,
  type EnrichmentWorkerIO, type ScoringWorkerIO, type EnrichmentJobMsg, type ScoringJobMsg,
  type SubscriberForEnrichment, type SubscriberForScoring, type EnrichmentCheckpoint,
} from './worker'
import { makeResult, ProviderOutcome, type EnrichmentProvider, type CanonicalFields } from './providers/base'
import type { QueueMessage } from './queue'
import type { CascadeStep, WaterfallResult } from './cascade'
import { defaultScoringConfig } from '../scoring/models'

const COMPLETE: CanonicalFields = { linkedin_profile_url: 'https://li/x', li_job_start_date: '2024-02-01', li_education_end_date: '2023-12-31' }

function stub(key: string, outcome: ProviderOutcome, fields: CanonicalFields, calls: string[]): EnrichmentProvider {
  return {
    providerKey: key, executionMode: 'sync',
    async enrich() { calls.push(key); return makeResult(key, outcome, { fields, charged: Object.keys(fields).length > 0, costUsd: 0.03, fullName: 'Jane Smith' }) },
  }
}

type FakeOpts = {
  messages: QueueMessage<EnrichmentJobMsg>[]
  subscriber?: SubscriberForEnrichment | null
  checkpoint?: EnrichmentCheckpoint | null
  blocked?: boolean
  allowAsync?: boolean
  calls: string[]
  providers: Record<string, EnrichmentProvider>
  throwOnPersist?: boolean
}

function fakeEnrichmentIO(o: FakeOpts) {
  const log = { archived: [] as number[], dlq: [] as number[], persisted: [] as Record<string, unknown>[], scoring: [] as string[], failedJobs: [] as string[], accumulated: [] as unknown[] }
  const io: EnrichmentWorkerIO = {
    async readChunk() { return o.messages },
    async archive(id) { log.archived.push(id) },
    async toDlq(id) { log.dlq.push(id) },
    async loadCascade() { return Object.keys(o.providers).map((providerKey, i): CascadeStep => ({ providerKey, executionMode: 'sync', position: i + 1 })) },
    async loadSubscriber() { return o.subscriber === undefined ? { id: 's1', email: 'a@b.com', name: 'Jane Smith', emailValidationStatus: null, emailValidatedAt: null, enrichmentPriority: 50 } : o.subscriber },
    async loadCheckpoint() { return o.checkpoint ?? null },
    getProvider(k) { return o.providers[k] ?? null },
    async checkAsyncHealth() { return o.allowAsync ?? true },
    async ensureValidation() { return o.blocked ?? false },
    async persistEnrichment(row) { if (o.throwOnPersist) throw new Error('db down'); log.persisted.push(row) },
    async accumulateJob(_jobId, delta) { log.accumulated.push(delta) },
    async failJob(jobId) { log.failedJobs.push(jobId) },
    async enqueueScoring(subscriberId) { log.scoring.push(subscriberId) },
    now: () => new Date('2026-06-15T00:00:00Z'),
  }
  return { io, log }
}

const msg = (over: Partial<QueueMessage<EnrichmentJobMsg>> = {}): QueueMessage<EnrichmentJobMsg> => ({
  msgId: 1, readCt: 1, message: { subscriberId: 's1', tenantId: 't1', jobId: 'job1' }, ...over,
})

describe('processEnrichmentChunk', () => {
  it('happy path: persists, accumulates, enqueues scoring, archives', async () => {
    const calls: string[] = []
    const { io, log } = fakeEnrichmentIO({ messages: [msg()], calls, providers: { hunter: stub('hunter', ProviderOutcome.COMPLETE, COMPLETE, calls) } })
    const r = await processEnrichmentChunk(io)
    expect(r.processed).toBe(1)
    expect(log.persisted).toHaveLength(1)
    expect(log.persisted[0].completeness).toBe('complete')
    expect(log.scoring).toEqual(['s1'])
    expect(log.archived).toEqual([1])
    expect(log.dlq).toEqual([])
  })

  it('poison guard: read_ct past MAX → DLQ + failJob, never processed', async () => {
    const calls: string[] = []
    const { io, log } = fakeEnrichmentIO({ messages: [msg({ readCt: 6 })], calls, providers: { hunter: stub('hunter', ProviderOutcome.COMPLETE, COMPLETE, calls) } })
    const r = await processEnrichmentChunk(io)
    expect(r.dlq).toBe(1)
    expect(log.dlq).toEqual([1])
    expect(log.failedJobs).toEqual(['job1'])
    expect(calls).toEqual([]) // provider never called
    expect(log.persisted).toEqual([])
  })

  it('blocked (Stage 0): no persist, still scores + archives', async () => {
    const calls: string[] = []
    const { io, log } = fakeEnrichmentIO({ messages: [msg()], blocked: true, calls, providers: { hunter: stub('hunter', ProviderOutcome.COMPLETE, COMPLETE, calls) } })
    const r = await processEnrichmentChunk(io)
    expect(r.blocked).toBe(1)
    expect(calls).toEqual([])
    expect(log.persisted).toEqual([])
    expect(log.scoring).toEqual(['s1']) // scored even when blocked
    expect(log.archived).toEqual([1])
    // 0044: a blocked message still counts toward job completion (zero money-path stats).
    expect(log.accumulated).toHaveLength(1)
    expect(log.accumulated[0]).toMatchObject({ perProvider: {}, costUsd: 0, processed: 1 })
  })

  it('missing subscriber: archived + skipped, nothing else', async () => {
    const calls: string[] = []
    const { io, log } = fakeEnrichmentIO({ messages: [msg()], subscriber: null, calls, providers: {} })
    const r = await processEnrichmentChunk(io)
    expect(r.skipped).toBe(1)
    expect(log.archived).toEqual([1])
    expect(log.scoring).toEqual([])
    // 0044: deleted-subscriber messages still tick processed or the job would hang 'running'.
    expect(log.accumulated).toHaveLength(1)
    expect(log.accumulated[0]).toMatchObject({ perProvider: {}, costUsd: 0, processed: 1 })
  })

  it('transient failure (persist throws): message left for retry, not archived', async () => {
    const calls: string[] = []
    const { io, log } = fakeEnrichmentIO({ messages: [msg()], throwOnPersist: true, calls, providers: { hunter: stub('hunter', ProviderOutcome.COMPLETE, COMPLETE, calls) } })
    const r = await processEnrichmentChunk(io)
    expect(r.failed).toBe(1)
    expect(log.archived).toEqual([]) // left in queue → vt retry
    expect(log.dlq).toEqual([])
  })

  it('checkpoint: already-attempted provider not re-called (no re-charge on retry)', async () => {
    const calls: string[] = []
    const { io, log } = fakeEnrichmentIO({
      messages: [msg({ readCt: 2 })], calls,
      providers: { hunter: stub('hunter', ProviderOutcome.COMPLETE, COMPLETE, calls) },
      checkpoint: { merged: { ...COMPLETE }, provenance: { li_job_start_date: 'hunter' }, attempted: [{ provider: 'hunter', outcome: 'complete' }] },
    })
    const r = await processEnrichmentChunk(io)
    expect(calls).toEqual([]) // hunter skipped via checkpoint
    expect(r.processed).toBe(1)
    // 0044 completion lifecycle: the retry still ticks processed, but with ZERO money-path stats
    // (no per-provider attempts/cost) — so no double-charge, and the job can still flip 'completed'.
    expect(log.accumulated).toHaveLength(1)
    expect(log.accumulated[0]).toMatchObject({ perProvider: {}, success: 0, miss: 0, costUsd: 0, processed: 1 })
  })
})

describe('jobDeltaFromResult', () => {
  const base: WaterfallResult = { merged: {}, provenance: {}, attempted: [], completeness: ProviderOutcome.MISS, pendingProvider: null, pendingReference: null, blocked: false, stats: {} }
  it('empty stats → zero money path (pure retry adds nothing)', () => {
    expect(jobDeltaFromResult(base)).toMatchObject({ success: 0, miss: 0, costUsd: 0, pdlCredits: 0 })
  })
  it('counts cost + pdl credits from providers that ran', () => {
    const d = jobDeltaFromResult({ ...base, completeness: ProviderOutcome.COMPLETE, stats: { pdl: { attempts: 1, hits: 1, costUsd: 0.28 }, hunter: { attempts: 1, hits: 0, costUsd: 0.004 } } })
    expect(d.success).toBe(1)
    expect(d.pdlCredits).toBe(1)
    expect(d.costUsd).toBeCloseTo(0.284, 4)
    expect(d.perProvider.pdl).toEqual({ attempts: 1, hits: 1, cost_usd: 0.28 })
  })
})

describe('buildEnrichmentRow', () => {
  it('maps canonical fields, completeness, 30-day delete_at, majority provider', () => {
    const wf: WaterfallResult = {
      merged: { ...COMPLETE }, provenance: { li_job_start_date: 'hunter', li_education_end_date: 'pdl', linkedin_profile_url: 'hunter' },
      attempted: [{ provider: 'hunter', outcome: 'partial' }, { provider: 'pdl', outcome: 'complete' }],
      completeness: ProviderOutcome.COMPLETE, pendingProvider: null, pendingReference: null, blocked: false, stats: {},
    }
    const row = buildEnrichmentRow('s1', 't1', wf, new Date('2026-06-15T00:00:00Z'))
    expect(row.subscriber_id).toBe('s1')
    expect(row.completeness).toBe('complete')
    expect(row.enrichment_provider).toBe('hunter') // majority (2 of 3 fields)
    expect(row.linkedin_profile_url).toBe('https://li/x')
    expect(row.delete_at).toBe('2026-07-15T00:00:00.000Z')
  })
})

describe('buildRecordFromDb', () => {
  it('copies normalized countries (B3 loop) and parses dates', () => {
    const s: SubscriberForScoring = {
      email: 'a@b.com', account_name: 'Acme', account_country: 'USA', institution_name: 'MIT',
      institution_location: 'Cambridge', institution_domain_verified: null, institution_country_normalized: 'United States',
      account_country_normalized: 'United States', stated_graduation_date: '2022-05-01',
      days_before_last_renewal: 400, subscription_start_date: '2020-01-01', subscription_end_date: '2025-01-01',
      li_current_employer_name: 'Gensler', li_job_end_date: null, li_job_title: 'Architect',
      li_education_end_date: '2022-01-01', li_current_employer_domain: 'gensler.com',
      verification_status: null, verification_confidence: null,
    }
    const rec = buildRecordFromDb(s)
    expect(rec.institutionCountryNormalized).toBe('United States')
    expect(rec.accountCountryNormalized).toBe('United States')
    expect(rec.renewalDeltaDays).toBe(400)
    expect(rec.proofSubmissionDate).toBeNull() // not captured at import
    expect(rec.statedGraduationDate?.getUTCFullYear()).toBe(2022)
  })
})

// ── Scoring worker ───────────────────────────────────────────────────────────────
function fakeScoringIO(messages: QueueMessage<ScoringJobMsg>[], sub: SubscriberForScoring | null) {
  const log = { archived: [] as number[], dlq: [] as number[], inserted: [] as Record<string, unknown>[] }
  const io: ScoringWorkerIO = {
    async readChunk() { return messages },
    async archive(id) { log.archived.push(id) },
    async toDlq(id) { log.dlq.push(id) },
    async loadSubscriberForScoring() { return sub },
    async loadScoringConfig() { return defaultScoringConfig() },
    async insertScore(row) { log.inserted.push(row) },
    now: () => new Date('2026-06-15T00:00:00Z'),
  }
  return { io, log }
}

const sMsg = (over: Partial<QueueMessage<ScoringJobMsg>> = {}): QueueMessage<ScoringJobMsg> => ({
  msgId: 9, readCt: 1, message: { subscriberId: 's1', tenantId: 't1' }, ...over,
})

const fullSub: SubscriberForScoring = {
  email: 'a@b.com', account_name: 'Acme', account_country: 'USA', institution_name: 'MIT',
  institution_location: 'Cambridge', institution_domain_verified: null, institution_country_normalized: 'United States', account_country_normalized: 'United States',
  stated_graduation_date: '2022-05-01', days_before_last_renewal: 400, subscription_start_date: '2020-01-01', subscription_end_date: '2025-01-01',
  li_current_employer_name: 'Gensler', li_job_end_date: null, li_job_title: 'Architect', li_education_end_date: '2022-01-01', li_current_employer_domain: 'gensler.com',
  verification_status: null, verification_confidence: null,
}

describe('processScoringChunk', () => {
  it('scores, inserts append-only row, archives', async () => {
    const { io, log } = fakeScoringIO([sMsg()], fullSub)
    const r = await processScoringChunk(io)
    expect(r.processed).toBe(1)
    expect(log.inserted).toHaveLength(1)
    expect(log.inserted[0].subscriber_id).toBe('s1')
    expect(typeof log.inserted[0].total_score).toBe('number')
    expect(log.archived).toEqual([9])
  })

  it('poison guard → DLQ, no insert', async () => {
    const { io, log } = fakeScoringIO([sMsg({ readCt: 6 })], fullSub)
    const r = await processScoringChunk(io)
    expect(r.dlq).toBe(1)
    expect(log.dlq).toEqual([9])
    expect(log.inserted).toEqual([])
  })

  it('missing subscriber → archived + skipped', async () => {
    const { io, log } = fakeScoringIO([sMsg()], null)
    const r = await processScoringChunk(io)
    expect(r.skipped).toBe(1)
    expect(log.archived).toEqual([9])
    expect(log.inserted).toEqual([])
  })

  // ── V1 authoritative-enrollment wiring (Part 7) ──────────────────────────────────
  it('unverified subscriber → score identical to no-verification (the no-op guarantee)', async () => {
    const baseline = (await (async () => { const { io, log } = fakeScoringIO([sMsg()], fullSub); await processScoringChunk(io); return log.inserted[0] })())
    const { io, log } = fakeScoringIO([sMsg()], { ...fullSub, verification_status: 'unverified', verification_confidence: null })
    await processScoringChunk(io)
    expect(log.inserted[0].total_score).toBe(baseline.total_score)
    expect(log.inserted[0].recommended_action).toBe(baseline.recommended_action)
  })

  it('verified_enrolled caps the live score below Tier-2', async () => {
    const { io, log } = fakeScoringIO([sMsg()], { ...fullSub, verification_status: 'verified_enrolled', verification_confidence: 'authoritative' })
    await processScoringChunk(io)
    expect(log.inserted[0].total_score as number).toBeLessThanOrEqual(defaultScoringConfig().tier2Threshold - 1)
    expect([0, 3]).toContain(log.inserted[0].confidence_tier) // below Tier-2: Clean or Watch, never Tier 1/2
  })

  it('verified_not_enrolled routes the live row to human review', async () => {
    const { io, log } = fakeScoringIO([sMsg()], { ...fullSub, verification_status: 'verified_not_enrolled', verification_confidence: 'authoritative' })
    await processScoringChunk(io)
    expect(log.inserted[0].recommended_action).toMatch(/Human Review/i)
  })
})
