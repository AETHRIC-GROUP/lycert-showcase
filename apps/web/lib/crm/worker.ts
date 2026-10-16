/**
 * CRM sync worker — pure orchestration over crm_sync_q (migration 0046), mirroring the enrichment/
 * verification worker.ts/worker-io.ts split (deps-injected, Supabase/HTTP live in worker-io.ts). Reuses
 * the enrichment queue runtime's generic q_* wrappers (same pattern as lib/verification/worker-io.ts) —
 * no new RPC surface. Bridge Part 5: all long-running CRM work runs here, never inside a request handler.
 *
 * Five message kinds. `bootstrap` (one-shot per connection, triggered at OAuth connect) does NOT
 * auto-chain — segment discovery (Part 6.5) is a separate admin step. The segment-config save route
 * enqueues the first `backfill_page` (after=null) once a property-mode segment exists. Each
 * `backfill_page` processes one HubSpot search page (<=200 contacts) and enqueues the next page if
 * `after` is returned, otherwise enqueues `writeback_batch`; each `writeback_batch` processes one
 * batch (<=100) and re-enqueues itself if more subscribers remain — same self-chaining durable pattern
 * as the FullEnrich async sweep. This two-phase (upsert-then-sweep) shape is specific to the ONE-TIME
 * initial backfill, where "write once per subscriber" is the correct semantics.
 *
 * M2 adds `webhook_event` (one per inbound HubSpot event, enqueued by the webhook route — never
 * batched/processed inline) and `reconcile_page` (same shape as backfill_page, filtered by
 * lastmodifieddate instead of the EDU segment alone). Both upsert THEN immediately call `writebackOne`
 * for exactly the contact(s) just touched, rather than chaining into writeback_batch — these are
 * incremental, ongoing paths where a contact that was already written back once must still be
 * re-checked on its next change (writeback_batch's `writeback_hash IS NULL` filter is write-once-ever,
 * correct only for the initial sweep).
 */
import type { QueueMessage } from '../enrichment/queue'
import { planPropertyBootstrap, LYCERT_PROPERTY_GROUP, LYCERT_PROPERTIES, type BootstrapPlan } from './properties'
import { mapContactToSubscriber, filterBackfillable, type InboundMapping, type HubspotContactRaw, type MappedSubscriberFields } from './backfill'
import { decideWriteback, type SubscriberForWriteback } from './writeback'
import type { WebhookAction } from './webhook-events'

export const BACKFILL_PAGE_SIZE = 200
export const WRITEBACK_BATCH_SIZE = 100
export const CRM_SYNC_VT_SECONDS = 120
export const MAX_READ_CT = 5

// 'bootstrap' and 'webhook_event' carry no runId — neither is one of crm_sync_runs's three kinds (Part
// 6.9: backfill | reconcile | writeback). Both are fast, single-item, idempotent actions: bootstrap runs
// once at OAuth connect; webhook_event runs once per inbound HubSpot event (never batched/processed inline
// — Bridge 6.6's own rule — the handler route enqueues one message per event and returns immediately).
export type CrmSyncJobMsg =
  | { tenantId: string; kind: 'bootstrap' }
  | { tenantId: string; kind: 'backfill_page'; runId: string; after: string | null }
  | { tenantId: string; kind: 'writeback_batch'; runId: string }
  | { tenantId: string; kind: 'webhook_event'; action: WebhookAction }
  | { tenantId: string; kind: 'reconcile_page'; runId: string; after: string | null; since: string }

export interface CrmConnectionForSync { id: string; accessToken: string; portalId: string }

export interface CrmSyncWorkerIO {
  readChunk(qty: number, vt: number): Promise<QueueMessage<CrmSyncJobMsg>[]>
  archive(msgId: number): Promise<void>
  toDlq(msgId: number, message: unknown): Promise<void>
  enqueue(messages: CrmSyncJobMsg[]): Promise<void>

  getConnection(tenantId: string): Promise<CrmConnectionForSync | null>
  markConnectionError(tenantId: string, error: string): Promise<void>

  // bootstrap
  getExistingProperties(accessToken: string): Promise<Array<{ name: string; type: string }>>
  applyBootstrapPlan(accessToken: string, plan: BootstrapPlan): Promise<void>
  recordBootstrapMappings(tenantId: string, plan: BootstrapPlan): Promise<void>

  // backfill
  getInboundMapping(tenantId: string): Promise<InboundMapping>
  searchPage(tenantId: string, accessToken: string, after: string | null): Promise<{ results: HubspotContactRaw[]; after: string | null }>
  upsertBackfillRows(tenantId: string, rows: MappedSubscriberFields[]): Promise<void>

  // webhook events (M2, Part 6.6) — each is a single-item, idempotent action
  getContactById(accessToken: string, crmObjectId: string, mapping: InboundMapping): Promise<HubspotContactRaw | null>
  deleteSubscriberMirror(tenantId: string, crmObjectId: string): Promise<void>
  relinkMergedContacts(tenantId: string, mergedObjectIds: string[]): Promise<void>

  // nightly reconcile (M2, Part 6.6) — same shape as backfill, filtered by lastmodifieddate
  searchReconcilePage(tenantId: string, accessToken: string, since: string, after: string | null): Promise<{ results: HubspotContactRaw[]; after: string | null }>
  updateReconcileWatermark(tenantId: string, at: Date): Promise<void>

  // writeback
  loadWritebackCandidates(tenantId: string, limit: number): Promise<Array<{
    subscriberId: string; crmObjectId: string; previousHash: string | null
    statedGraduationDate: string | null; lifecycleStage: string; totalScore: number | null
  }>>
  applyWritebackBatch(accessToken: string, tenantId: string, items: Array<{
    subscriberId: string; crmObjectId: string; hash: string; properties: Record<string, string>
  }>): Promise<void>
  /** M2's incremental path: re-checks (and writes if changed) exactly one already-mirrored contact —
   * unlike loadWritebackCandidates, this can fire again for a contact that was already written once. */
  writebackOne(tenantId: string, accessToken: string, crmObjectId: string): Promise<void>
  /** Bridge Part 9 trigger (automatic half — "manual" is already covered by the existing Enrich-All
   * route, since CRM-mirrored subscribers are ordinary `subscribers` rows). No-op if the subscriber
   * doesn't qualify or has already been auto-enriched once (see enrichment-trigger.ts). */
  maybeTriggerEnrichment(tenantId: string, crmObjectId: string): Promise<void>

  // observability (Bridge Part 6.9 crm_sync_runs)
  touchSyncRun(runId: string, delta: { apiCalls?: number; counts?: Record<string, number> }): Promise<void>
  finishSyncRun(runId: string, status: 'completed' | 'failed', error?: string): Promise<void>
  now(): Date
}

export interface ChunkResult {
  read: number; processed: number; failed: number; dlq: number
  lastError?: string
}

function emptyResult(): ChunkResult {
  return { read: 0, processed: 0, failed: 0, dlq: 0 }
}

export async function processCrmSyncChunk(io: CrmSyncWorkerIO): Promise<ChunkResult> {
  const result = emptyResult()
  const messages = await io.readChunk(1, CRM_SYNC_VT_SECONDS)
  result.read = messages.length
  for (const msg of messages) {
    try {
      await processOne(io, msg)
      await io.archive(msg.msgId)
      result.processed++
    } catch (e) {
      result.lastError = String(e)
      if (msg.readCt >= MAX_READ_CT) {
        await io.toDlq(msg.msgId, msg.message)
        result.dlq++
      } else {
        result.failed++
        // leave the message in place — pgmq redelivers after the visibility timeout
      }
    }
  }
  return result
}

async function processOne(io: CrmSyncWorkerIO, msg: QueueMessage<CrmSyncJobMsg>): Promise<void> {
  const { message } = msg

  if (message.kind === 'bootstrap') {
    // Does NOT auto-chain into backfill: segment discovery (Part 6.5) is a separate admin step the
    // client hasn't necessarily completed yet right after OAuth connect. The segment-config save route
    // enqueues the first `backfill_page` once a property-mode segment exists — chaining here would just
    // retry-fail against a missing crm_segment_config row. No crm_sync_runs row for this kind (Part 6.9
    // only enumerates backfill/reconcile/writeback) — a dropped connection just lets the message retry/DLQ.
    const conn = await io.getConnection(message.tenantId)
    if (!conn) throw new Error('connection not found or disconnected')
    await runBootstrap(io, message.tenantId, conn)
    return
  }

  if (message.kind === 'webhook_event') {
    // No crm_sync_runs row (same reasoning as bootstrap) — a single event is too fine-grained to track
    // as a "run"; a dropped connection just retries/DLQs like any other message.
    const conn = await io.getConnection(message.tenantId)
    if (!conn) throw new Error('connection not found or disconnected')
    await runWebhookAction(io, message.tenantId, conn, message.action)
    return
  }

  const conn = await io.getConnection(message.tenantId)
  if (!conn) {
    await io.finishSyncRun(message.runId, 'failed', 'connection not found or disconnected')
    return
  }

  if (message.kind === 'backfill_page') {
    const done = await runBackfillPage(io, message.tenantId, conn, message.after)
    if (done.after) {
      await io.enqueue([{ tenantId: message.tenantId, kind: 'backfill_page', runId: message.runId, after: done.after }])
    } else {
      await io.enqueue([{ tenantId: message.tenantId, kind: 'writeback_batch', runId: message.runId }])
    }
    return
  }

  if (message.kind === 'reconcile_page') {
    // Unlike backfill_page, this does NOT chain into writeback_batch — runReconcilePage already writes
    // back exactly the contacts each page touched (writebackOne per row), so there's nothing left to sweep.
    const done = await runReconcilePage(io, message.tenantId, conn, message.since, message.after)
    if (done.after) {
      await io.enqueue([{ tenantId: message.tenantId, kind: 'reconcile_page', runId: message.runId, after: done.after, since: message.since }])
    } else {
      await io.updateReconcileWatermark(message.tenantId, io.now())
      await io.finishSyncRun(message.runId, 'completed')
    }
    return
  }

  // writeback_batch
  const more = await runWritebackBatch(io, message.tenantId, conn)
  if (more) {
    await io.enqueue([{ tenantId: message.tenantId, kind: 'writeback_batch', runId: message.runId }])
  } else {
    await io.finishSyncRun(message.runId, 'completed')
  }
}

async function runWebhookAction(
  io: CrmSyncWorkerIO, tenantId: string, conn: CrmConnectionForSync, action: WebhookAction,
): Promise<void> {
  if (action.type === 'delete') {
    await io.deleteSubscriberMirror(tenantId, action.crmObjectId)
    return
  }
  if (action.type === 'merge') {
    // The merged-away ids no longer exist as separate HubSpot records — drop their mirrors. The
    // survivor (primaryObjectId) is handled by re-fetching it below, same as any upsert.
    await io.relinkMergedContacts(tenantId, action.mergedObjectIds)
    const mapping = await io.getInboundMapping(tenantId)
    const contact = await io.getContactById(conn.accessToken, action.primaryObjectId, mapping)
    if (contact) {
      const mapped = mapContactToSubscriber(contact, mapping)
      if (mapped.email) {
        await io.upsertBackfillRows(tenantId, [mapped])
        await io.writebackOne(tenantId, conn.accessToken, action.primaryObjectId)
        await io.maybeTriggerEnrichment(tenantId, action.primaryObjectId)
      }
    }
    return
  }
  // upsert (creation or propertyChange) — re-mirror then immediately re-check write-back for this one
  // contact (Bridge M2 accept: "re-writes only changed Lycert fields" — writebackOne's hash-diff is what
  // makes this a no-op when nothing Lycert-relevant actually changed).
  const mapping = await io.getInboundMapping(tenantId)
  const contact = await io.getContactById(conn.accessToken, action.crmObjectId, mapping)
  if (!contact) return // deleted/merged-away between the webhook firing and this call — not an error
  const mapped = mapContactToSubscriber(contact, mapping)
  if (mapped.email) {
    await io.upsertBackfillRows(tenantId, [mapped])
    await io.writebackOne(tenantId, conn.accessToken, action.crmObjectId)
    await io.maybeTriggerEnrichment(tenantId, action.crmObjectId)
  }
}

async function runReconcilePage(
  io: CrmSyncWorkerIO, tenantId: string, conn: CrmConnectionForSync, since: string, after: string | null,
): Promise<{ after: string | null }> {
  const mapping = await io.getInboundMapping(tenantId)
  const page = await io.searchReconcilePage(tenantId, conn.accessToken, since, after)
  const mapped = page.results.map(c => mapContactToSubscriber(c, mapping))
  const rows = filterBackfillable(mapped)
  if (rows.length > 0) {
    await io.upsertBackfillRows(tenantId, rows)
    // Same reasoning as the webhook upsert path: re-check write-back for exactly the contacts this page
    // touched, not a full-table sweep. writebackOne's hash-diff makes unchanged contacts a no-op.
    for (const row of rows) {
      await io.writebackOne(tenantId, conn.accessToken, row.crmObjectId)
      await io.maybeTriggerEnrichment(tenantId, row.crmObjectId)
    }
  }
  return { after: page.after }
}

async function runBootstrap(io: CrmSyncWorkerIO, tenantId: string, conn: CrmConnectionForSync): Promise<void> {
  const existing = await io.getExistingProperties(conn.accessToken)
  const plan = planPropertyBootstrap(existing)
  if (plan.toCreate.length > 0) {
    await io.applyBootstrapPlan(conn.accessToken, plan)
  }
  await io.recordBootstrapMappings(tenantId, plan)
}

async function runBackfillPage(
  io: CrmSyncWorkerIO, tenantId: string, conn: CrmConnectionForSync, after: string | null,
): Promise<{ after: string | null; count: number }> {
  const mapping = await io.getInboundMapping(tenantId)
  const page = await io.searchPage(tenantId, conn.accessToken, after)
  const mapped = page.results.map(c => mapContactToSubscriber(c, mapping))
  const rows = filterBackfillable(mapped)
  if (rows.length > 0) await io.upsertBackfillRows(tenantId, rows)
  return { after: page.after, count: rows.length }
}

async function runWritebackBatch(io: CrmSyncWorkerIO, tenantId: string, conn: CrmConnectionForSync): Promise<boolean> {
  const candidates = await io.loadWritebackCandidates(tenantId, WRITEBACK_BATCH_SIZE)
  if (candidates.length === 0) return false
  const now = io.now()
  const toWrite: Array<{ subscriberId: string; crmObjectId: string; hash: string; properties: Record<string, string> }> = []
  for (const c of candidates) {
    const sub: SubscriberForWriteback = {
      statedGraduationDate: c.statedGraduationDate, lifecycleStage: c.lifecycleStage, totalScore: c.totalScore,
    }
    const decision = decideWriteback(sub, now, c.previousHash)
    if (decision.shouldWrite) {
      toWrite.push({ subscriberId: c.subscriberId, crmObjectId: c.crmObjectId, hash: decision.hash, properties: decision.properties })
    }
  }
  if (toWrite.length > 0) await io.applyWritebackBatch(conn.accessToken, tenantId, toWrite)
  // More work remains iff this page was full (there may be another page of candidates).
  return candidates.length === WRITEBACK_BATCH_SIZE
}

export { LYCERT_PROPERTY_GROUP, LYCERT_PROPERTIES }
