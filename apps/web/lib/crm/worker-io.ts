/**
 * Supabase + HubSpot bindings for the CRM sync worker (worker.ts is pure over this interface).
 * Mirrors lib/verification/worker-io.ts: reuses the enrichment queue runtime's generic q_* wrappers
 * and serviceClient — no new RPC surface, no new Supabase client factory.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { serviceClient } from '../enrichment/worker-io'
import { readBatch, archive as qArchive, toDlq as qToDlq, enqueue as qEnqueue, type RpcClient } from '../enrichment/queue'
import { decryptCredential, encryptCredential } from '../crypto'
import {
  getProperty, createPropertyGroup, createProperty, searchContacts, batchUpdateContacts, refreshAccessToken,
  getContact,
} from './hubspot-client'
import { LYCERT_PROPERTY_GROUP, LYCERT_PROPERTIES, type BootstrapPlan } from './properties'
import { DEFAULT_INBOUND_MAPPING, type InboundMapping, type HubspotContactRaw, type MappedSubscriberFields } from './backfill'
import { decideWriteback, type SubscriberForWriteback } from './writeback'
import { shouldAutoTriggerEnrichment } from './enrichment-trigger'
import { QUEUES as ENRICHMENT_QUEUES } from '../enrichment/queue'
import type { EnrichmentJobMsg } from '../enrichment/worker'
import type { CrmSyncJobMsg, CrmSyncWorkerIO, CrmConnectionForSync } from './worker'

export const CRM_QUEUES = { crmSync: 'crm_sync_q', crmSyncDlq: 'crm_sync_dlq' } as const

const OBJECT_TYPE = 'contacts'
// Refresh proactively once the access token is within this many seconds of its stored expiry
// (Bridge 6.3 step 5: "refresh at 80% of expires_in" — approximated here via an absolute buffer
// since we store access_expires_at, not the original expires_in window).
const REFRESH_BUFFER_SECONDS = 300

/**
 * Process-wide token-bucket limiter for outbound HubSpot calls (Bridge 6.6: "token-bucket limiter per
 * portal: default 100 req/10s, configurable" — this keeps the connector well under HubSpot's own
 * 110 req/10 s marketplace ceiling regardless of how many tenants' sync jobs a single worker invocation
 * processes). Same minInterval construction as the enrichment providers' TokenBucket (clients.ts).
 */
class TokenBucket {
  private next = 0
  constructor(private minIntervalMs: number) {}
  async acquire(): Promise<void> {
    const now = Date.now()
    const wait = this.next - now
    if (wait > 0) await new Promise(r => setTimeout(r, wait))
    this.next = Math.max(now, this.next) + this.minIntervalMs
  }
}
const RATE_PER_10S = Number(process.env.LYCERT_HUBSPOT_RATE_LIMIT_PER_10S ?? 100)
const hubspotLimiter = new TokenBucket(10_000 / Math.max(1, RATE_PER_10S))

export function makeCrmSyncIO(db: SupabaseClient = serviceClient()): CrmSyncWorkerIO {
  const rpc = db as unknown as RpcClient

  async function getRawConnection(tenantId: string) {
    const { data, error } = await db
      .from('crm_connections')
      .select('id, access_token_enc, access_expires_at, refresh_token_enc')
      .eq('tenant_id', tenantId).eq('provider', 'hubspot').neq('status', 'disconnected')
      .maybeSingle()
    if (error) throw new Error(`getRawConnection: ${error.message}`)
    return data as null | {
      id: string; access_token_enc: string; access_expires_at: string; refresh_token_enc: string
    }
  }

  async function loadSegmentFilter(tenantId: string): Promise<{ property: string; value: string }> {
    const { data: seg, error: segErr } = await db.from('crm_segment_config')
      .select('mode, definition').eq('tenant_id', tenantId).eq('provider', 'hubspot').maybeSingle()
    if (segErr) throw new Error(`segment lookup: ${segErr.message}`)
    if (!seg || seg.mode !== 'property') throw new Error('no property-mode segment config for tenant')
    return seg.definition as { property: string; value: string }
  }

  async function loadInboundMapping(tenantId: string): Promise<InboundMapping> {
    const { data, error } = await db.from('crm_property_mappings')
      .select('lycert_field, crm_property')
      .eq('tenant_id', tenantId).eq('provider', 'hubspot').eq('direction', 'inbound')
    if (error) throw new Error(`getInboundMapping: ${error.message}`)
    if (!data || data.length === 0) return DEFAULT_INBOUND_MAPPING
    const mapping: InboundMapping = {}
    for (const row of data as Array<{ lycert_field: string; crm_property: string }>) mapping[row.lycert_field] = row.crm_property
    return mapping
  }

  /** Latest subscriber_scores.total_score per subscriber id (one query for a whole batch). */
  async function loadLatestScores(subscriberIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>()
    if (subscriberIds.length === 0) return out
    const { data, error } = await db.from('subscriber_scores')
      .select('subscriber_id, total_score, scored_at')
      .in('subscriber_id', subscriberIds)
      .order('scored_at', { ascending: false })
    if (error) throw new Error(`loadLatestScores: ${error.message}`)
    for (const row of (data ?? []) as Array<{ subscriber_id: string; total_score: number }>) {
      if (!out.has(row.subscriber_id)) out.set(row.subscriber_id, row.total_score) // first = most recent
    }
    return out
  }

  async function applyWritebackBatchImpl(accessToken: string, tenantId: string, items: Array<{
    subscriberId: string; crmObjectId: string; hash: string; properties: Record<string, string>
  }>): Promise<void> {
    await hubspotLimiter.acquire()
    await batchUpdateContacts(accessToken, items.map(i => ({ id: i.crmObjectId, properties: i.properties })))
    const now = new Date().toISOString()
    for (const item of items) {
      const { error } = await db.from('crm_contact_links')
        .update({ writeback_hash: item.hash, last_writeback_at: now })
        .eq('tenant_id', tenantId).eq('provider', 'hubspot').eq('crm_object_id', item.crmObjectId)
      if (error) throw new Error(`applyWritebackBatch persist: ${error.message}`)
    }
  }

  return {
    async readChunk(qty, vt) {
      return readBatch<CrmSyncJobMsg>(rpc, CRM_QUEUES.crmSync, qty, vt)
    },
    archive: (msgId) => qArchive(rpc, CRM_QUEUES.crmSync, msgId),
    toDlq: (msgId, message) => qToDlq(rpc, CRM_QUEUES.crmSync, CRM_QUEUES.crmSyncDlq, msgId, message),
    enqueue: (messages) => qEnqueue(rpc, CRM_QUEUES.crmSync, messages).then(() => undefined),

    async getConnection(tenantId): Promise<CrmConnectionForSync | null> {
      const row = await getRawConnection(tenantId)
      if (!row) return null
      const expiresAt = new Date(row.access_expires_at).getTime()
      const soon = Date.now() + REFRESH_BUFFER_SECONDS * 1000
      if (expiresAt > soon) {
        return { id: row.id, accessToken: decryptCredential(row.access_token_enc), portalId: '' }
      }
      // Proactive refresh.
      const clientId = process.env.LYCERT_HUBSPOT_CLIENT_ID ?? ''
      const clientSecret = process.env.LYCERT_HUBSPOT_CLIENT_SECRET ?? ''
      const refreshToken = decryptCredential(row.refresh_token_enc)
      await hubspotLimiter.acquire()
      const refreshed = await refreshAccessToken({ clientId, clientSecret, refreshToken })
      const newExpiresAt = new Date(Date.now() + refreshed.expiresIn * 1000).toISOString()
      const { error } = await db.from('crm_connections').update({
        access_token_enc: encryptCredential(refreshed.accessToken),
        refresh_token_enc: encryptCredential(refreshed.refreshToken),
        access_expires_at: newExpiresAt,
        status: 'connected',
        last_error: null,
      }).eq('id', row.id)
      if (error) throw new Error(`refresh persist: ${error.message}`)
      return { id: row.id, accessToken: refreshed.accessToken, portalId: '' }
    },

    async markConnectionError(tenantId, error) {
      await db.from('crm_connections').update({ status: 'error', last_error: error })
        .eq('tenant_id', tenantId).eq('provider', 'hubspot')
    },

    async getExistingProperties(accessToken) {
      const out: Array<{ name: string; type: string }> = []
      for (const def of LYCERT_PROPERTIES) {
        await hubspotLimiter.acquire()
        const existing = await getProperty(OBJECT_TYPE, def.name, accessToken)
        if (existing) out.push(existing)
      }
      return out
    },

    async applyBootstrapPlan(accessToken, plan: BootstrapPlan) {
      if (plan.toCreate.length === 0) return
      await hubspotLimiter.acquire()
      await createPropertyGroup(OBJECT_TYPE, LYCERT_PROPERTY_GROUP, accessToken)
      for (const def of plan.toCreate) {
        await hubspotLimiter.acquire()
        await createProperty(OBJECT_TYPE, {
          groupName: LYCERT_PROPERTY_GROUP.name, name: def.name, label: def.label,
          type: def.type, fieldType: def.fieldType, options: def.options,
        }, accessToken)
      }
    },

    async recordBootstrapMappings(tenantId, plan: BootstrapPlan) {
      const rows = [
        ...plan.toCreate.map(d => ({ lycert_field: d.name, status: 'ok', created_by_lycert: true })),
        ...plan.ok.map(name => ({ lycert_field: name, status: 'ok', created_by_lycert: true })),
        ...plan.conflicts.map(c => ({ lycert_field: c.name, status: 'conflict', created_by_lycert: false })),
      ]
      for (const r of rows) {
        const { error } = await db.from('crm_property_mappings').upsert({
          tenant_id: tenantId, provider: 'hubspot', direction: 'outbound',
          lycert_field: r.lycert_field, crm_property: r.lycert_field,
          created_by_lycert: r.created_by_lycert, status: r.status,
        }, { onConflict: 'tenant_id,provider,direction,lycert_field', ignoreDuplicates: false })
        if (error) throw new Error(`recordBootstrapMappings: ${error.message}`)
      }
    },

    getInboundMapping: loadInboundMapping,

    async searchPage(tenantId, accessToken, after) {
      const def = await loadSegmentFilter(tenantId)
      const mapping = await loadInboundMapping(tenantId)
      const properties = Array.from(new Set(Object.values(mapping)))
      await hubspotLimiter.acquire()
      const resp = await searchContacts({
        accessToken,
        filters: [{ propertyName: def.property, operator: 'EQ', value: def.value }],
        properties,
        limit: 200,
        after: after ?? undefined,
      })
      const results: HubspotContactRaw[] = resp.results.map(r => ({ id: r.id, properties: r.properties }))
      return { results, after: resp.after }
    },

    async searchReconcilePage(tenantId, accessToken, since, after) {
      // Reconcile stays scoped to the EDU segment (same filter as backfill) PLUS lastmodifieddate — it
      // exists to catch missed webhooks on contacts we already care about, not to scan the whole portal.
      const def = await loadSegmentFilter(tenantId)
      const mapping = await loadInboundMapping(tenantId)
      const properties = Array.from(new Set(Object.values(mapping)))
      await hubspotLimiter.acquire()
      const resp = await searchContacts({
        accessToken,
        filters: [
          { propertyName: def.property, operator: 'EQ', value: def.value },
          { propertyName: 'lastmodifieddate', operator: 'GT', value: since },
        ],
        properties,
        limit: 200,
        after: after ?? undefined,
      })
      const results: HubspotContactRaw[] = resp.results.map(r => ({ id: r.id, properties: r.properties }))
      return { results, after: resp.after }
    },

    async upsertBackfillRows(tenantId, rows: MappedSubscriberFields[]) {
      for (const row of rows) {
        if (!row.email) continue
        const { data: sub, error: subErr } = await db.from('subscribers')
          .upsert({
            tenant_id: tenantId, email: row.email, name: row.name,
            institution_name: row.institutionName, account_country: row.accountCountry,
            stated_graduation_date: row.statedGraduationDate,
          }, { onConflict: 'tenant_id,email' })
          .select('id').single()
        if (subErr) throw new Error(`upsertBackfillRows subscriber: ${subErr.message}`)
        const { error: linkErr } = await db.from('crm_contact_links').upsert({
          tenant_id: tenantId, subscriber_id: (sub as { id: string }).id, provider: 'hubspot',
          crm_object_id: row.crmObjectId, last_inbound_at: new Date().toISOString(),
        }, { onConflict: 'tenant_id,provider,crm_object_id' })
        if (linkErr) throw new Error(`upsertBackfillRows link: ${linkErr.message}`)
      }
    },

    async getContactById(accessToken, crmObjectId, mapping) {
      const properties = Array.from(new Set(Object.values(mapping)))
      await hubspotLimiter.acquire()
      const contact = await getContact(accessToken, crmObjectId, properties)
      return contact ? { id: contact.id, properties: contact.properties } : null
    },

    async deleteSubscriberMirror(tenantId, crmObjectId) {
      const { data: link } = await db.from('crm_contact_links')
        .select('subscriber_id').eq('tenant_id', tenantId).eq('provider', 'hubspot')
        .eq('crm_object_id', crmObjectId).maybeSingle()
      if (!link) return // already gone / never synced — idempotent no-op
      const subscriberId = (link as { subscriber_id: string }).subscriber_id
      const { error } = await db.from('subscribers').delete().eq('id', subscriberId)
      if (error) throw new Error(`deleteSubscriberMirror: ${error.message}`)
      // Bridge 6.6: "keep anonymised audit entries" — resource_id has no FK, so prior entries already
      // survive the delete untouched; this just records the deletion event itself for the audit trail.
      await db.from('audit_logs').insert({
        tenant_id: tenantId, actor_type: 'system', action: 'crm.hubspot.contact_deleted',
        resource_type: 'subscriber', resource_id: subscriberId, metadata: { crm_object_id: crmObjectId },
      })
    },

    async relinkMergedContacts(tenantId, mergedObjectIds) {
      if (mergedObjectIds.length === 0) return
      for (const crmObjectId of mergedObjectIds) {
        const { data: link } = await db.from('crm_contact_links')
          .select('subscriber_id').eq('tenant_id', tenantId).eq('provider', 'hubspot')
          .eq('crm_object_id', crmObjectId).maybeSingle()
        if (!link) continue
        const { error } = await db.from('subscribers').delete().eq('id', (link as { subscriber_id: string }).subscriber_id)
        if (error) throw new Error(`relinkMergedContacts: ${error.message}`)
      }
    },

    async updateReconcileWatermark(tenantId, at) {
      const { error } = await db.from('crm_connections')
        .update({ last_reconcile_at: at.toISOString() })
        .eq('tenant_id', tenantId).eq('provider', 'hubspot')
      if (error) throw new Error(`updateReconcileWatermark: ${error.message}`)
    },

    async maybeTriggerEnrichment(tenantId, crmObjectId) {
      const { data: link } = await db.from('crm_contact_links')
        .select('subscriber_id').eq('tenant_id', tenantId).eq('provider', 'hubspot')
        .eq('crm_object_id', crmObjectId).maybeSingle()
      if (!link) return
      const subscriberId = (link as { subscriber_id: string }).subscriber_id
      const { data: sub, error: subErr } = await db.from('subscribers')
        .select('lifecycle_stage, last_enriched_at').eq('id', subscriberId).maybeSingle()
      if (subErr || !sub) return
      const { data: scoreRows } = await db.from('subscriber_scores')
        .select('confidence_tier').eq('subscriber_id', subscriberId)
        .order('scored_at', { ascending: false }).limit(1)
      const confidenceTier = (scoreRows?.[0] as { confidence_tier: number } | undefined)?.confidence_tier ?? null
      const row = sub as { lifecycle_stage: string; last_enriched_at: string | null }
      if (!shouldAutoTriggerEnrichment({ lifecycleStage: row.lifecycle_stage, confidenceTier, lastEnrichedAt: row.last_enriched_at })) return

      const { data: job, error: jobErr } = await db.from('enrichment_jobs').insert({
        tenant_id: tenantId, job_type: 'single', trigger_reason: 'crm_sync', status: 'running',
        subscriber_ids: [subscriberId], total_count: 1, started_at: new Date().toISOString(),
      }).select('id').single()
      if (jobErr || !job) throw new Error(`maybeTriggerEnrichment job create: ${jobErr?.message}`)
      const message: EnrichmentJobMsg = { subscriberId, tenantId, jobId: (job as { id: string }).id }
      await qEnqueue(rpc, ENRICHMENT_QUEUES.enrichment, [message])
    },

    async loadWritebackCandidates(tenantId, limit) {
      // M1 scope: write once per subscriber during the initial backfill+write-back pass. Filtering on
      // writeback_hash IS NULL is what makes pagination advance — without it, every call would refetch
      // the same first `limit` rows forever (no offset/cursor), never reaching the rest. This is ONLY
      // correct for a one-time initial sweep. M2's incremental paths (webhook_event, reconcile_page) do
      // NOT reuse this — they call writebackOne per upserted contact instead, so an already-written
      // contact's later changes still get re-checked (see writebackOne below).
      const { data, error } = await db.from('crm_contact_links')
        .select('subscriber_id, crm_object_id, writeback_hash, subscribers!inner(stated_graduation_date, lifecycle_stage)')
        .eq('tenant_id', tenantId).eq('provider', 'hubspot')
        .is('writeback_hash', null)
        .limit(limit)
      if (error) throw new Error(`loadWritebackCandidates: ${error.message}`)
      const subscriberIds = (data ?? []).map((r: Record<string, unknown>) => r.subscriber_id as string)
      const scores = await loadLatestScores(subscriberIds)
      return (data ?? []).map((r: Record<string, unknown>) => {
        const sub = r.subscribers as { stated_graduation_date: string | null; lifecycle_stage: string }
        const subscriberId = r.subscriber_id as string
        return {
          subscriberId,
          crmObjectId: r.crm_object_id as string,
          previousHash: (r.writeback_hash as string | null) ?? null,
          statedGraduationDate: sub.stated_graduation_date,
          lifecycleStage: sub.lifecycle_stage,
          totalScore: scores.get(subscriberId) ?? null,
        }
      })
    },

    async writebackOne(tenantId, accessToken, crmObjectId) {
      const { data: link, error: linkErr } = await db.from('crm_contact_links')
        .select('subscriber_id, writeback_hash, subscribers!inner(stated_graduation_date, lifecycle_stage)')
        .eq('tenant_id', tenantId).eq('provider', 'hubspot').eq('crm_object_id', crmObjectId).maybeSingle()
      if (linkErr) throw new Error(`writebackOne lookup: ${linkErr.message}`)
      if (!link) return // nothing to write back for a contact we don't mirror
      const row = link as unknown as {
        subscriber_id: string; writeback_hash: string | null
        subscribers: { stated_graduation_date: string | null; lifecycle_stage: string }
      }
      const scores = await loadLatestScores([row.subscriber_id])
      const sub: SubscriberForWriteback = {
        statedGraduationDate: row.subscribers.stated_graduation_date,
        lifecycleStage: row.subscribers.lifecycle_stage,
        totalScore: scores.get(row.subscriber_id) ?? null,
      }
      const decision = decideWriteback(sub, new Date(), row.writeback_hash)
      if (!decision.shouldWrite) return
      await applyWritebackBatchImpl(accessToken, tenantId, [
        { subscriberId: row.subscriber_id, crmObjectId, hash: decision.hash, properties: decision.properties },
      ])
    },

    applyWritebackBatch: applyWritebackBatchImpl,

    async touchSyncRun(runId, delta) {
      const { data, error: selErr } = await db.from('crm_sync_runs').select('api_calls, counts').eq('id', runId).maybeSingle()
      if (selErr) throw new Error(`touchSyncRun select: ${selErr.message}`)
      const apiCalls = (data?.api_calls ?? 0) + (delta.apiCalls ?? 0)
      const counts = { ...(data?.counts ?? {}), ...(delta.counts ?? {}) }
      const { error } = await db.from('crm_sync_runs').update({ api_calls: apiCalls, counts }).eq('id', runId)
      if (error) throw new Error(`touchSyncRun update: ${error.message}`)
    },

    async finishSyncRun(runId, status, error) {
      await db.from('crm_sync_runs').update({ status, error: error ?? null, finished_at: new Date().toISOString() }).eq('id', runId)
    },

    now: () => new Date(),
  }
}
