/**
 * Supabase + pgmq bindings for the queue workers (worker.ts is pure over these interfaces).
 * Constructed per request from the service-role client. Provider API keys come from env; the
 * cascade is memoized per tenant for the lifetime of one chunk.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  readBatch, archive as qArchive, toDlq as qToDlq, enqueue, QUEUES, type RpcClient, type QueueMessage,
} from './queue'
import { buildCascade, type CascadeStep, type AttemptedEntry } from './cascade'
import { CANONICAL_ENRICHMENT_FIELDS, type CanonicalFields, type EnrichmentProvider } from './providers/base'
import { makeProvider, type ProviderKeys } from './providers'
import { ZeroBounceClient, BLOCKING_VALIDATION_STATUSES } from './providers/zerobounce'
import { withWebhookToken } from './providers/fullenrich'
import { scoringConfigFromRow, type ScoringConfig } from '../scoring/models'
import type {
  EnrichmentWorkerIO, ScoringWorkerIO, EnrichmentJobMsg, ScoringJobMsg,
  SubscriberForEnrichment, SubscriberForScoring, EnrichmentCheckpoint, EnrichmentUpsertRow,
  ScoreInsertRow, JobDelta,
} from './worker'

// V2 Part 1.1 Stage-0 gate. The set of blocking statuses is the single policy source in zerobounce.ts
// (currently `disposable`-only — see that file / DECISIONS.md). Cached verdicts are re-validated after
// this TTL so a status can't go stale forever (V2 §1.1: cache email validation ~180 days).
const VALIDATION_TTL_MS = 180 * 24 * 60 * 60 * 1000
function validationBlocks(status: string | null): boolean {
  return status != null && BLOCKING_VALIDATION_STATUSES.has(status)
}

export function serviceClient(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_LYCERT_SUPABASE_URL!,
    process.env.LYCERT_SUPABASE_SERVICE_ROLE_KEY!,
  )
}

function providerKeysFromEnv(): ProviderKeys {
  return {
    hunter: process.env.LYCERT_HUNTER_API_KEY,
    reversecontact: process.env.LYCERT_REVERSECONTACT_API_KEY,
    datagma: process.env.LYCERT_DATAGMA_API_KEY,
    pdl: process.env.LYCERT_PDL_API_KEY,
    apollo: process.env.LYCERT_APOLLO_API_KEY,
    fullenrich: process.env.LYCERT_FULLENRICH_API_KEY,
    fullenrichWebhookUrl: process.env.LYCERT_FULLENRICH_WEBHOOK_URL,
  }
}

// ── Enrichment worker IO ─────────────────────────────────────────────────────────
export function makeEnrichmentIO(db: SupabaseClient = serviceClient()): EnrichmentWorkerIO {
  const rpc = db as unknown as RpcClient
  const keys = providerKeysFromEnv()
  const cascadeCache = new Map<string, CascadeStep[]>()
  let asyncHealth: boolean | null = null // cached per worker invocation

  return {
    async readChunk(qty, vt) {
      return readBatch<EnrichmentJobMsg>(rpc, QUEUES.enrichment, qty, vt)
    },

    async checkAsyncHealth() {
      if (asyncHealth !== null) return asyncHealth
      // No FullEnrich key → nothing to submit, so the async path is moot (not "unhealthy", just absent).
      if (!keys.fullenrich) { asyncHealth = false; return false }
      const url = process.env.LYCERT_FULLENRICH_WEBHOOK_URL ?? ''
      // 1) Static guard — the regression check for the 2026-06-21 placeholder incident. A real https URL
      //    with no unsubstituted `<...>` placeholder. This alone catches the "https://<staging>/..." bug.
      if (!/^https:\/\//.test(url) || /[<>]/.test(url)) {
        console.warn('[enrichment/async-health] webhook URL missing/placeholder — skipping FullEnrich: %s', url || '(unset)')
        asyncHealth = false
        return false
      }
      // 2) Active ping — POST the EXACT callback URL the submit will use (same env var + withWebhookToken,
      //    so token + Vercel bypass are identical). The receiver returns 200 for an empty body. A non-200
      //    means our side isn't fully wired (deploy down, token mismatch, SSO wall) → don't spend credits.
      try {
        const resp = await fetch(withWebhookToken(url), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        })
        asyncHealth = resp.ok
        if (!resp.ok) console.warn('[enrichment/async-health] webhook ping returned %d — skipping FullEnrich', resp.status)
      } catch (e) {
        console.warn('[enrichment/async-health] webhook ping failed (%s) — skipping FullEnrich', String(e))
        asyncHealth = false
      }
      return asyncHealth
    },
    archive: (msgId) => qArchive(rpc, QUEUES.enrichment, msgId),
    toDlq: (msgId, message) => qToDlq(rpc, QUEUES.enrichment, QUEUES.enrichmentDlq, msgId, message),

    async loadCascade(tenantId) {
      const cached = cascadeCache.get(tenantId)
      if (cached) return cached
      const { data: providers } = await db
        .from('enrichment_providers')
        .select('provider_key, provider_type, execution_mode, enabled, default_position')
      const { data: overrides } = await db
        .from('tenant_waterfall_config')
        .select('provider_key, position, enabled')
        .eq('tenant_id', tenantId)
      const cascade = buildCascade((providers ?? []) as never[], (overrides ?? []) as never[])
      cascadeCache.set(tenantId, cascade)
      return cascade
    },

    async loadSubscriber(subscriberId, tenantId) {
      const { data } = await db
        .from('subscribers')
        .select('id, email, name, email_validation_status, email_validated_at, enrichment_priority')
        .eq('id', subscriberId).eq('tenant_id', tenantId).maybeSingle()
      if (!data) return null
      const r = data as unknown as Record<string, unknown>
      return {
        id: r.id as string,
        email: (r.email as string) ?? '',
        name: (r.name as string | null) ?? null,
        emailValidationStatus: (r.email_validation_status as string | null) ?? null,
        emailValidatedAt: (r.email_validated_at as string | null) ?? null,
        enrichmentPriority: (r.enrichment_priority as number | null) ?? 0,
      } satisfies SubscriberForEnrichment
    },

    async loadCheckpoint(subscriberId) {
      const { data } = await db
        .from('subscriber_enrichment')
        .select('*').eq('subscriber_id', subscriberId).maybeSingle()
      if (!data) return null
      const row = data as unknown as Record<string, unknown>
      const merged: CanonicalFields = {}
      for (const f of Array.from(CANONICAL_ENRICHMENT_FIELDS)) if (row[f] != null) merged[f] = row[f]
      return {
        merged,
        provenance: (row.field_provenance as Record<string, string>) ?? {},
        attempted: (row.providers_attempted as AttemptedEntry[]) ?? [],
      } satisfies EnrichmentCheckpoint
    },

    getProvider(key, jobId): EnrichmentProvider | null {
      return makeProvider(key, keys, jobId)
    },

    async ensureValidation(sub) {
      // Use the cached verdict while it's fresh — no second ZeroBounce charge inside the TTL.
      const cachedAt = sub.emailValidatedAt ? new Date(sub.emailValidatedAt).getTime() : 0
      if (sub.emailValidationStatus != null && Date.now() - cachedAt < VALIDATION_TTL_MS) {
        return validationBlocks(sub.emailValidationStatus)
      }
      const result = await new ZeroBounceClient(process.env.LYCERT_ZEROBOUNCE_API_KEY ?? '').validate(sub.email)
      // Missing key / outage → never cache a placeholder (so it re-validates once the key/service is
      // back) and never block coverage. validate() reports these as rawStatus 'no_key' / 'error'.
      if (result.rawStatus === 'no_key' || result.rawStatus === 'error') return false

      const patch: Record<string, unknown> = {
        email_validation_status: result.status,
        email_validated_at: new Date().toISOString(),
        email_typo_suggestion: result.didYouMean,
      }
      // Disposable also hard-classifies the domain (so B1 + the dashboard reflect it).
      if (result.emailDomainTypeOverride) patch.email_domain_type = result.emailDomainTypeOverride
      const { error } = await db.from('subscribers').update(patch).eq('id', sub.id)
      if (error) throw new Error(`ensureValidation persist: ${error.message}`)
      const blocks = validationBlocks(result.status)
      console.log('[enrichment/validation] sub=%s status=%s blocks=%s cost=%d', sub.id, result.status, blocks, result.costUsd)
      return blocks
    },

    async persistEnrichment(row: EnrichmentUpsertRow) {
      const { error } = await db.from('subscriber_enrichment').upsert(row, { onConflict: 'subscriber_id' })
      if (error) throw new Error(`persistEnrichment: ${error.message}`)
    },

    async accumulateJob(jobId, delta: JobDelta) {
      const { error } = await db.rpc('q_job_accumulate', {
        p_job_id: jobId,
        p_stats: delta.perProvider,
        p_success: delta.success,
        p_miss: delta.miss,
        p_error: 0,
        p_low_quality: 0,
        p_pdl_credits: delta.pdlCredits,
        p_cost: delta.costUsd,
        p_async_pending: delta.asyncPending,
        p_processed: delta.processed,
      })
      if (error) throw new Error(`accumulateJob: ${error.message}`)
    },

    async failJob(jobId, message) {
      await db.from('enrichment_jobs')
        .update({ status: 'failed', error_message: message, completed_at: new Date().toISOString() })
        .eq('id', jobId)
    },

    async enqueueScoring(subscriberId, tenantId) {
      const msg: ScoringJobMsg = { subscriberId, tenantId, referenceDate: null }
      await enqueue(rpc, QUEUES.scoring, [msg])
    },

    now: () => new Date(),
  }
}

// ── Scoring worker IO ────────────────────────────────────────────────────────────
const SCORING_COLUMNS = [
  'email', 'account_name', 'account_country', 'institution_name', 'institution_location',
  'institution_domain_verified',
  'institution_country_normalized', 'account_country_normalized', 'stated_graduation_date',
  'days_before_last_renewal', 'subscription_start_date', 'subscription_end_date',
  'verification_status', 'verification_confidence', // V1 authoritative-enrollment signal (Part 7)
].join(', ')

export function makeScoringIO(db: SupabaseClient = serviceClient()): ScoringWorkerIO {
  const rpc = db as unknown as RpcClient
  // tenant_scoring_config, cached per worker invocation (a chunk is usually one tenant's batch).
  const configCache = new Map<string, ScoringConfig>()
  return {
    async readChunk(qty, vt) {
      return readBatch<ScoringJobMsg>(rpc, QUEUES.scoring, qty, vt)
    },
    archive: (msgId) => qArchive(rpc, QUEUES.scoring, msgId),
    toDlq: (msgId, message) => qToDlq(rpc, QUEUES.scoring, QUEUES.scoringDlq, msgId, message),

    async loadSubscriberForScoring(subscriberId, tenantId) {
      const { data: sub } = await db
        .from('subscribers').select(SCORING_COLUMNS)
        .eq('id', subscriberId).eq('tenant_id', tenantId).maybeSingle()
      if (!sub) return null
      const { data: enr } = await db
        .from('subscriber_enrichment')
        .select('li_current_employer_name, li_job_end_date, li_job_title, li_education_end_date, li_current_employer_domain')
        .eq('subscriber_id', subscriberId).maybeSingle()
      const s = sub as unknown as Record<string, unknown>
      const e = (enr ?? {}) as unknown as Record<string, unknown>
      return {
        email: (s.email as string) ?? null,
        account_name: (s.account_name as string) ?? null,
        account_country: (s.account_country as string) ?? null,
        institution_name: (s.institution_name as string) ?? null,
        institution_location: (s.institution_location as string) ?? null,
        institution_domain_verified: (s.institution_domain_verified as string) ?? null,
        institution_country_normalized: (s.institution_country_normalized as string) ?? null,
        account_country_normalized: (s.account_country_normalized as string) ?? null,
        stated_graduation_date: (s.stated_graduation_date as string) ?? null,
        days_before_last_renewal: (s.days_before_last_renewal as number) ?? null,
        subscription_start_date: (s.subscription_start_date as string) ?? null,
        subscription_end_date: (s.subscription_end_date as string) ?? null,
        li_current_employer_name: (e.li_current_employer_name as string) ?? null,
        li_job_end_date: (e.li_job_end_date as string) ?? null,
        li_job_title: (e.li_job_title as string) ?? null,
        li_education_end_date: (e.li_education_end_date as string) ?? null,
        li_current_employer_domain: (e.li_current_employer_domain as string) ?? null,
        verification_status: (s.verification_status as string) ?? null,
        verification_confidence: (s.verification_confidence as string) ?? null,
      } satisfies SubscriberForScoring
    },

    // Tenant overrides layered over the CEDS defaults (per-field fallback: a missing row or column
    // scores byte-identically to CEDS — the onboarding-seeded rows carry the default values anyway).
    async loadScoringConfig(tenantId): Promise<ScoringConfig> {
      const cached = configCache.get(tenantId)
      if (cached) return cached
      const { data } = await db
        .from('tenant_scoring_config').select('*').eq('tenant_id', tenantId).maybeSingle()
      const config = scoringConfigFromRow(data as Record<string, unknown> | null)
      configCache.set(tenantId, config)
      return config
    },

    async insertScore(row: ScoreInsertRow) {
      const { error } = await db.from('subscriber_scores').insert(row)
      if (error) throw new Error(`insertScore: ${error.message}`)
    },

    now: () => new Date(),
  }
}
