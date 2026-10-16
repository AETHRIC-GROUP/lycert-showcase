/** CRM sync worker orchestration tests — fake IO, no Supabase, no network. */
import { describe, it, expect } from 'vitest'
import { processCrmSyncChunk, type CrmSyncWorkerIO, type CrmSyncJobMsg, type CrmConnectionForSync } from './worker'
import type { QueueMessage } from '../enrichment/queue'
import type { BootstrapPlan } from './properties'
import type { HubspotContactRaw } from './backfill'

type FakeOpts = {
  messages: QueueMessage<CrmSyncJobMsg>[]
  connection?: CrmConnectionForSync | null
  existingProperties?: Array<{ name: string; type: string }>
  searchResults?: Array<{ id: string; properties: Record<string, string | null> }>
  searchAfter?: string | null
  writebackCandidates?: Array<{
    subscriberId: string; crmObjectId: string; previousHash: string | null
    statedGraduationDate: string | null; lifecycleStage: string; totalScore: number | null
  }>
  contactById?: HubspotContactRaw | null
  reconcileResults?: Array<{ id: string; properties: Record<string, string | null> }>
  reconcileAfter?: string | null
}

function fakeIO(o: FakeOpts) {
  const log = {
    archived: [] as number[], dlq: [] as number[], enqueued: [] as CrmSyncJobMsg[],
    bootstrapApplied: null as BootstrapPlan | null, mappingsRecorded: null as BootstrapPlan | null,
    upserted: [] as unknown[], writtenBack: [] as unknown[], runsFinished: [] as Array<{ runId: string; status: string }>,
    deletedMirrors: [] as string[], relinkedMerged: [] as string[], writebackOneCalls: [] as string[],
    watermarkUpdates: [] as Date[], enrichmentTriggerCalls: [] as string[],
  }
  const io: CrmSyncWorkerIO = {
    async readChunk() { return o.messages },
    async archive(id) { log.archived.push(id) },
    async toDlq(id) { log.dlq.push(id) },
    async enqueue(msgs) { log.enqueued.push(...msgs) },
    async getConnection() { return o.connection === undefined ? { id: 'c1', accessToken: 'tok', portalId: 'p1' } : o.connection },
    async markConnectionError() {},
    async getExistingProperties() { return o.existingProperties ?? [] },
    async applyBootstrapPlan(_token, plan) { log.bootstrapApplied = plan },
    async recordBootstrapMappings(_tenantId, plan) { log.mappingsRecorded = plan },
    async getInboundMapping() { return { email: 'email' } },
    async searchPage() { return { results: o.searchResults ?? [], after: o.searchAfter ?? null } },
    async upsertBackfillRows(_tenantId, rows) { log.upserted.push(...rows) },
    async getContactById() { return o.contactById === undefined ? null : o.contactById },
    async deleteSubscriberMirror(_tenantId, crmObjectId) { log.deletedMirrors.push(crmObjectId) },
    async relinkMergedContacts(_tenantId, ids) { log.relinkedMerged.push(...ids) },
    async searchReconcilePage() { return { results: o.reconcileResults ?? [], after: o.reconcileAfter ?? null } },
    async updateReconcileWatermark(_tenantId, at) { log.watermarkUpdates.push(at) },
    async loadWritebackCandidates() { return o.writebackCandidates ?? [] },
    async applyWritebackBatch(_token, _tenantId, items) { log.writtenBack.push(...items) },
    async writebackOne(_tenantId, _token, crmObjectId) { log.writebackOneCalls.push(crmObjectId) },
    async maybeTriggerEnrichment(_tenantId, crmObjectId) { log.enrichmentTriggerCalls.push(crmObjectId) },
    async touchSyncRun() {},
    async finishSyncRun(runId, status) { log.runsFinished.push({ runId, status }) },
    now: () => new Date('2026-10-09T00:00:00Z'),
  }
  return { io, log }
}

const msg = (message: CrmSyncJobMsg, over: Partial<QueueMessage<CrmSyncJobMsg>> = {}): QueueMessage<CrmSyncJobMsg> =>
  ({ msgId: 1, readCt: 1, message, ...over })

describe('processCrmSyncChunk — bootstrap', () => {
  it('plans + applies + records mappings, then archives (no re-chain, no sync run)', async () => {
    const { io, log } = fakeIO({ messages: [msg({ tenantId: 't1', kind: 'bootstrap' })], existingProperties: [] })
    const result = await processCrmSyncChunk(io)
    expect(result).toMatchObject({ read: 1, processed: 1, failed: 0, dlq: 0 })
    expect(log.bootstrapApplied?.toCreate.length).toBeGreaterThan(0)
    expect(log.mappingsRecorded).not.toBeNull()
    expect(log.enqueued).toHaveLength(0)
    expect(log.archived).toEqual([1])
  })

  it('a missing connection fails the message (retried, not DLQ-routed on the first attempt)', async () => {
    const { io, log } = fakeIO({ messages: [msg({ tenantId: 't1', kind: 'bootstrap' }), ], connection: null })
    const result = await processCrmSyncChunk(io)
    expect(result.failed).toBe(1)
    expect(log.archived).toHaveLength(0)
  })
})

describe('processCrmSyncChunk — backfill_page', () => {
  it('maps + upserts a page, then enqueues the next page when `after` is returned', async () => {
    const { io, log } = fakeIO({
      messages: [msg({ tenantId: 't1', kind: 'backfill_page', runId: 'r1', after: null })],
      searchResults: [{ id: 'c123', properties: { email: 'a@b.com' } }],
      searchAfter: 'cursor-2',
    })
    const result = await processCrmSyncChunk(io)
    expect(result.processed).toBe(1)
    expect(log.upserted).toHaveLength(1)
    expect(log.enqueued).toEqual([{ tenantId: 't1', kind: 'backfill_page', runId: 'r1', after: 'cursor-2' }])
  })

  it('enqueues writeback_batch once the last page (no `after`) is processed', async () => {
    const { io, log } = fakeIO({
      messages: [msg({ tenantId: 't1', kind: 'backfill_page', runId: 'r1', after: 'cursor-2' })],
      searchResults: [], searchAfter: null,
    })
    await processCrmSyncChunk(io)
    expect(log.enqueued).toEqual([{ tenantId: 't1', kind: 'writeback_batch', runId: 'r1' }])
  })

  it('a missing connection fails the sync run explicitly', async () => {
    const { io, log } = fakeIO({
      messages: [msg({ tenantId: 't1', kind: 'backfill_page', runId: 'r1', after: null })], connection: null,
    })
    await processCrmSyncChunk(io)
    expect(log.runsFinished).toEqual([{ runId: 'r1', status: 'failed' }])
  })
})

describe('processCrmSyncChunk — writeback_batch', () => {
  it('writes only changed subscribers and re-enqueues when the candidate page was full', async () => {
    const candidates = Array.from({ length: 100 }, (_, i) => ({
      subscriberId: `s${i}`, crmObjectId: `c${i}`, previousHash: null,
      statedGraduationDate: '2027-01-01', lifecycleStage: 'active_student', totalScore: null,
    }))
    const { io, log } = fakeIO({
      messages: [msg({ tenantId: 't1', kind: 'writeback_batch', runId: 'r1' })],
      writebackCandidates: candidates,
    })
    await processCrmSyncChunk(io)
    expect(log.writtenBack).toHaveLength(100)
    expect(log.enqueued).toEqual([{ tenantId: 't1', kind: 'writeback_batch', runId: 'r1' }])
  })

  it('finishes the run as completed when no candidates remain', async () => {
    const { io, log } = fakeIO({
      messages: [msg({ tenantId: 't1', kind: 'writeback_batch', runId: 'r1' })], writebackCandidates: [],
    })
    await processCrmSyncChunk(io)
    expect(log.runsFinished).toEqual([{ runId: 'r1', status: 'completed' }])
    expect(log.enqueued).toHaveLength(0)
  })

  it('skips a candidate whose hash already matches (no unnecessary HubSpot write)', async () => {
    // previousHash equal to the hash decideWriteback would compute for this exact state -> shouldWrite=false
    const { decideWriteback } = await import('./writeback')
    const sub = { statedGraduationDate: '2027-01-01', lifecycleStage: 'active_student', totalScore: null }
    const unchanged = decideWriteback(sub, new Date('2026-10-09T00:00:00Z'), null)
    const { io, log } = fakeIO({
      messages: [msg({ tenantId: 't1', kind: 'writeback_batch', runId: 'r1' })],
      writebackCandidates: [{ subscriberId: 's1', crmObjectId: 'c1', previousHash: unchanged.hash, ...sub }],
    })
    await processCrmSyncChunk(io)
    expect(log.writtenBack).toHaveLength(0)
  })
})

describe('processCrmSyncChunk — webhook_event (M2)', () => {
  it('upsert action: re-fetches the contact, upserts, and re-checks write-back for exactly that contact', async () => {
    const { io, log } = fakeIO({
      messages: [msg({ tenantId: 't1', kind: 'webhook_event', action: { type: 'upsert', crmObjectId: 'c1' } })],
      contactById: { id: 'c1', properties: { email: 'a@b.com' } },
    })
    const result = await processCrmSyncChunk(io)
    expect(result.processed).toBe(1)
    expect(log.upserted).toHaveLength(1)
    expect(log.writebackOneCalls).toEqual(['c1'])
    expect(log.enrichmentTriggerCalls).toEqual(['c1'])
    expect(log.enqueued).toHaveLength(0) // no re-chain — single-item action
  })

  it('upsert action is a safe no-op if the contact is gone by the time we fetch it (deleted/merged-away mid-flight)', async () => {
    const { io, log } = fakeIO({
      messages: [msg({ tenantId: 't1', kind: 'webhook_event', action: { type: 'upsert', crmObjectId: 'c1' } })],
      contactById: null,
    })
    const result = await processCrmSyncChunk(io)
    expect(result.processed).toBe(1)
    expect(log.upserted).toHaveLength(0)
    expect(log.writebackOneCalls).toHaveLength(0)
  })

  it('delete action removes the mirror — no write-back call (there is nothing left to write to)', async () => {
    const { io, log } = fakeIO({
      messages: [msg({ tenantId: 't1', kind: 'webhook_event', action: { type: 'delete', crmObjectId: 'c1' } })],
    })
    await processCrmSyncChunk(io)
    expect(log.deletedMirrors).toEqual(['c1'])
    expect(log.writebackOneCalls).toHaveLength(0)
    expect(log.enrichmentTriggerCalls).toHaveLength(0)
  })

  it('merge action relinks the merged-away ids and re-upserts the survivor', async () => {
    const { io, log } = fakeIO({
      messages: [msg({ tenantId: 't1', kind: 'webhook_event', action: { type: 'merge', primaryObjectId: 'p1', mergedObjectIds: ['m1', 'm2'] } })],
      contactById: { id: 'p1', properties: { email: 'survivor@b.com' } },
    })
    await processCrmSyncChunk(io)
    expect(log.relinkedMerged).toEqual(['m1', 'm2'])
    expect(log.upserted).toHaveLength(1)
    expect(log.writebackOneCalls).toEqual(['p1'])
  })

  it('a missing connection throws (retried like any other message — no runId to fail explicitly)', async () => {
    const { io, log } = fakeIO({
      messages: [msg({ tenantId: 't1', kind: 'webhook_event', action: { type: 'delete', crmObjectId: 'c1' } })],
      connection: null,
    })
    const result = await processCrmSyncChunk(io)
    expect(result.failed).toBe(1)
    expect(log.deletedMirrors).toHaveLength(0)
  })
})

describe('processCrmSyncChunk — reconcile_page (M2)', () => {
  it('upserts a page and writes back each touched contact immediately (no writeback_batch chain)', async () => {
    const { io, log } = fakeIO({
      messages: [msg({ tenantId: 't1', kind: 'reconcile_page', runId: 'r1', after: null, since: '2026-10-01T00:00:00Z' })],
      reconcileResults: [{ id: 'c1', properties: { email: 'a@b.com' } }, { id: 'c2', properties: { email: 'b@b.com' } }],
      reconcileAfter: null,
    })
    await processCrmSyncChunk(io)
    expect(log.upserted).toHaveLength(2)
    expect(log.writebackOneCalls.sort()).toEqual(['c1', 'c2'])
    expect(log.enrichmentTriggerCalls.sort()).toEqual(['c1', 'c2'])
    expect(log.watermarkUpdates).toHaveLength(1)
    expect(log.runsFinished).toEqual([{ runId: 'r1', status: 'completed' }])
    expect(log.enqueued).toHaveLength(0)
  })

  it('pages through `after` without touching the watermark until the last page', async () => {
    const { io, log } = fakeIO({
      messages: [msg({ tenantId: 't1', kind: 'reconcile_page', runId: 'r1', after: null, since: '2026-10-01T00:00:00Z' })],
      reconcileResults: [{ id: 'c1', properties: { email: 'a@b.com' } }],
      reconcileAfter: 'cursor-2',
    })
    await processCrmSyncChunk(io)
    expect(log.watermarkUpdates).toHaveLength(0)
    expect(log.enqueued).toEqual([{ tenantId: 't1', kind: 'reconcile_page', runId: 'r1', after: 'cursor-2', since: '2026-10-01T00:00:00Z' }])
  })

  it('a missing connection fails the run explicitly, same as backfill_page', async () => {
    const { io, log } = fakeIO({
      messages: [msg({ tenantId: 't1', kind: 'reconcile_page', runId: 'r1', after: null, since: '2026-10-01T00:00:00Z' })],
      connection: null,
    })
    await processCrmSyncChunk(io)
    expect(log.runsFinished).toEqual([{ runId: 'r1', status: 'failed' }])
  })
})

describe('processCrmSyncChunk — DLQ', () => {
  it('a missing connection fails cleanly (archived via finishSyncRun, not retried) — no retry can fix a disconnected tenant', async () => {
    const { io, log } = fakeIO({
      messages: [msg({ tenantId: 't1', kind: 'backfill_page', runId: 'r1', after: null }, { readCt: 6 })],
      connection: null,
    })
    const result = await processCrmSyncChunk(io)
    expect(result.processed).toBe(1)
    expect(log.runsFinished).toEqual([{ runId: 'r1', status: 'failed' }])
  })

  it('routes a genuinely failing message to the DLQ once it has exceeded MAX_READ_CT', async () => {
    const messages = [msg({ tenantId: 't1', kind: 'backfill_page', runId: 'r1', after: null }, { readCt: 6 })]
    const { io, log } = fakeIO({ messages })
    io.searchPage = async () => { throw new Error('HubSpot 500') }
    const result = await processCrmSyncChunk(io)
    expect(result.dlq).toBe(1)
    expect(log.dlq).toEqual([1])
  })

  it('a transient failure below MAX_READ_CT is left for pgmq to redeliver, not archived or DLQ\'d', async () => {
    const messages = [msg({ tenantId: 't1', kind: 'backfill_page', runId: 'r1', after: null }, { readCt: 1 })]
    const { io, log } = fakeIO({ messages })
    io.searchPage = async () => { throw new Error('HubSpot 500') }
    const result = await processCrmSyncChunk(io)
    expect(result.failed).toBe(1)
    expect(log.archived).toHaveLength(0)
    expect(log.dlq).toHaveLength(0)
  })
})
