/**
 * Durable-queue workers — the bounded chunk processors that the Vercel routes call (invoked by
 * pg_cron via pg_net). ENGINE_CONSOLIDATION_PLAN.md: batch enrichment/scoring NEVER runs inside a
 * request handler; each invocation drains one bounded chunk and returns.
 *
 * The orchestration here is PURE over an injected IO interface (same deps-injection pattern as
 * runPreEnrichment) so the full retry / checkpoint / DLQ semantics are unit-testable with fakes.
 * Supabase + pgmq + provider wiring lives in worker-io.ts.
 *
 * pgmq retry contract (relied on throughout):
 *   - read() increments read_ct and hides the message for vt seconds.
 *   - SUCCESS  → archive (message leaves the queue).
 *   - TRANSIENT failure → do nothing; the message reappears after vt and is retried.
 *   - POISON  → when read_ct exceeds MAX_READ_CT it is routed to the DLQ *before* re-attempting,
 *     so a message that keeps failing can never re-charge providers indefinitely.
 *
 * No-double-charge guarantee: every attempt persists the merged enrichment row BEFORE archiving.
 * On a retry, loadCheckpoint() rebuilds {merged, provenance, attempted} from that row and seeds
 * runWaterfall, which skips already-attempted providers — so credits are charged at most once.
 */
import {
  ENRICHMENT_CHUNK_SIZE, ENRICHMENT_VT_SECONDS, SCORING_CHUNK_SIZE, SCORING_VT_SECONDS, MAX_READ_CT,
  type QueueMessage,
} from './queue'
import {
  runWaterfall, majorityProvider, type CascadeStep, type AttemptedEntry, type WaterfallResult,
} from './cascade'
import { ProviderOutcome, stripToCanonical, type CanonicalFields, type EnrichmentProvider } from './providers/base'
import { scoreRow } from '../scoring/engine'
import type { VerificationSignalInput } from '../scoring/verification-signal'
import type { Confidence, SubscriberVerificationStatus } from '../verification/base'
import type { SubscriberRecord, ScoringConfig } from '../scoring/models'
import { parseDate } from '../scoring/field-mapper'

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

// ── Message shapes (the JSON in each queue entry) ───────────────────────────────
export type EnrichmentJobMsg = { subscriberId: string; tenantId: string; jobId: string | null }
export type ScoringJobMsg = { subscriberId: string; tenantId: string; referenceDate?: string | null }

// ── Rows the IO layer loads/persists ────────────────────────────────────────────
export type SubscriberForEnrichment = {
  id: string
  email: string
  name: string | null
  emailValidationStatus: string | null
  emailValidatedAt: string | null
  enrichmentPriority: number
}

/** Reconstructed from a prior subscriber_enrichment row so a retry never re-charges. */
export type EnrichmentCheckpoint = {
  merged: CanonicalFields
  provenance: Record<string, string>
  attempted: AttemptedEntry[]
}

export type EnrichmentUpsertRow = Record<string, unknown> & {
  subscriber_id: string
  tenant_id: string
  completeness: string
  enrichment_provider: string
}

export type JobDelta = {
  perProvider: Record<string, { attempts: number; hits: number; cost_usd: number }>
  success: number
  miss: number
  costUsd: number
  pdlCredits: number
  asyncPending: number
  /** Handled-message tick (0044): drives the job-completion flip when processed ≥ total_count. */
  processed: number
}

/** Zero-stat delta that still ticks the processed counter (blocked / deleted-subscriber / pure-retry
 * messages count toward completion even though no provider ran). */
export function processedOnlyDelta(): JobDelta {
  return { perProvider: {}, success: 0, miss: 0, costUsd: 0, pdlCredits: 0, asyncPending: 0, processed: 1 }
}

/** Subscriber + its latest enrichment, flattened, for the scoring builder. */
export type SubscriberForScoring = {
  email: string | null
  account_name: string | null
  account_country: string | null
  institution_name: string | null
  institution_location: string | null
  institution_domain_verified: string | null
  institution_country_normalized: string | null
  account_country_normalized: string | null
  stated_graduation_date: string | null
  days_before_last_renewal: number | null
  subscription_start_date: string | null
  subscription_end_date: string | null
  li_current_employer_name: string | null
  li_job_end_date: string | null
  li_job_title: string | null
  li_education_end_date: string | null
  li_current_employer_domain: string | null
  // V1 authoritative-enrollment signal (Part 7). When unverified/null, scoreRow treats it as a no-op.
  verification_status: string | null
  verification_confidence: string | null
}

export type ScoreInsertRow = {
  subscriber_id: string
  tenant_id: string
  total_score: number
  confidence_tier: number
  tier_label: string
  data_confidence: string
  primary_signal: string | null
  supporting_signals: string | null
  signals_count: number
  signals_fired: string | null
  data_gaps: string | null
  aec_professional_confirmed: boolean
  recommended_action: string
  scoring_version: string
  scored_at?: string
}

// ── IO interfaces (implemented for real in worker-io.ts, faked in tests) ─────────
export interface EnrichmentWorkerIO {
  readChunk(qty: number, vt: number): Promise<QueueMessage<EnrichmentJobMsg>[]>
  archive(msgId: number): Promise<void>
  toDlq(msgId: number, message: EnrichmentJobMsg): Promise<void>
  loadCascade(tenantId: string): Promise<CascadeStep[]>
  loadSubscriber(subscriberId: string, tenantId: string): Promise<SubscriberForEnrichment | null>
  loadCheckpoint(subscriberId: string): Promise<EnrichmentCheckpoint | null>
  getProvider(key: string, jobId: string | null): EnrichmentProvider | null
  /**
   * Preflight for the paid async sweep (FullEnrich). Returns false when the webhook callback path
   * isn't fully functional (URL unset/placeholder, deploy down, token mismatch) so we never spend
   * credits on results that can't come back. Checked once per chunk and cached.
   */
  checkAsyncHealth(): Promise<boolean>
  /**
   * Stage-0 email-validation gate (Part 1.1). Returns true when paid enrichment must be skipped.
   * Live: uses the cached email_validation_status when fresh (<180d) and otherwise calls ZeroBounce,
   * persisting the verdict back to the subscriber so the credit is spent at most once per cache window
   * (idempotent across retries). Never blocks on a missing key or provider outage.
   */
  ensureValidation(sub: SubscriberForEnrichment): Promise<boolean>
  persistEnrichment(row: EnrichmentUpsertRow): Promise<void>
  accumulateJob(jobId: string, delta: JobDelta): Promise<void>
  failJob(jobId: string, message: string): Promise<void>
  enqueueScoring(subscriberId: string, tenantId: string): Promise<void>
  now(): Date
}

export interface ScoringWorkerIO {
  readChunk(qty: number, vt: number): Promise<QueueMessage<ScoringJobMsg>[]>
  archive(msgId: number): Promise<void>
  toDlq(msgId: number, message: ScoringJobMsg): Promise<void>
  loadSubscriberForScoring(subscriberId: string, tenantId: string): Promise<SubscriberForScoring | null>
  loadScoringConfig(tenantId: string): Promise<ScoringConfig>
  insertScore(row: ScoreInsertRow): Promise<void>
  now(): Date
}

export type ChunkResult = { read: number; processed: number; blocked: number; failed: number; dlq: number; skipped: number; lastError?: string }

// ── Pure builders ────────────────────────────────────────────────────────────────

/** Map a finished waterfall onto a subscriber_enrichment upsert row. enrichment_provider is the
 * majority field source (kept for the dashboard); the per-field truth is field_provenance. */
export function buildEnrichmentRow(
  subscriberId: string, tenantId: string, wf: WaterfallResult, now: Date,
): EnrichmentUpsertRow {
  const canonical = stripToCanonical(wf.merged)
  const lastAttempted = wf.attempted[wf.attempted.length - 1]?.provider ?? 'pdl'
  return {
    subscriber_id: subscriberId,
    tenant_id: tenantId,
    ...canonical,
    field_provenance: wf.provenance,
    providers_attempted: wf.attempted,
    completeness: wf.completeness,
    pending_async_provider: wf.pendingProvider,
    // Store the async job id + submit time so a lost webhook can be reconciled by polling (0034).
    async_reference: wf.pendingReference,
    async_submitted_at: wf.pendingProvider ? now.toISOString() : null,
    enrichment_provider: majorityProvider(wf.provenance, lastAttempted),
    enriched_at: now.toISOString(),
    delete_at: new Date(now.getTime() + THIRTY_DAYS_MS).toISOString(),
  }
}

/** Per-job accounting deltas for one subscriber. Money path (per_provider_stats / cost / pdl
 * credits) is derived only from providers actually called THIS run (wf.stats), so a pure retry —
 * where every provider is checkpoint-skipped and wf.stats is empty — adds zero. Subscriber-level
 * success/miss counters are best-effort observability and only move when something ran this run. */
export function jobDeltaFromResult(wf: WaterfallResult): JobDelta {
  const perProvider: JobDelta['perProvider'] = {}
  let costUsd = 0
  for (const [key, s] of Object.entries(wf.stats)) {
    perProvider[key] = { attempts: s.attempts, hits: s.hits, cost_usd: s.costUsd }
    costUsd += s.costUsd
  }
  const providersRan = Object.keys(wf.stats).length > 0
  const pdlCredits = wf.stats.pdl?.attempts ?? 0
  let success = 0
  let miss = 0
  if (providersRan) {
    if (wf.completeness === ProviderOutcome.MISS) miss = 1
    else success = 1
  }
  return {
    perProvider,
    success,
    miss,
    costUsd: Math.round(costUsd * 10000) / 10000,
    pdlCredits,
    asyncPending: wf.pendingProvider ? 1 : 0,
    processed: 1,
  }
}

/** Build a SubscriberRecord from DB columns. Copies the pre-enrichment normalized countries so B3
 * compares Location-Cleaner output (raw+alias fallback lives inside scoreB3). proof_submission_date
 * is not captured at import → A3 is an honest data gap. */
export function buildRecordFromDb(s: SubscriberForScoring): SubscriberRecord {
  return {
    email: s.email ?? '',
    accountName: s.account_name ?? '',
    institutionName: s.institution_name ?? '',
    institutionLocation: s.institution_location ?? '',
    institutionDomainVerified: s.institution_domain_verified ?? undefined,
    accountCountry: s.account_country ?? '',
    institutionCountryNormalized: s.institution_country_normalized ?? undefined,
    accountCountryNormalized: s.account_country_normalized ?? undefined,
    statedGraduationDate: parseDate(s.stated_graduation_date),
    renewalDeltaDays: s.days_before_last_renewal ?? null,
    proofSubmissionDate: null,
    subscriptionStartDate: parseDate(s.subscription_start_date),
    subscriptionEndDate: parseDate(s.subscription_end_date),
    liCurrentEmployerName: s.li_current_employer_name ?? '',
    liJobEndDate: parseDate(s.li_job_end_date),
    liJobTitle: s.li_job_title ?? '',
    liEducationEndDate: parseDate(s.li_education_end_date),
    liCurrentEmployerDomain: s.li_current_employer_domain ?? '',
  }
}

// ── Enrichment chunk processor ───────────────────────────────────────────────────
export async function processEnrichmentChunk(io: EnrichmentWorkerIO): Promise<ChunkResult> {
  const msgs = await io.readChunk(ENRICHMENT_CHUNK_SIZE, ENRICHMENT_VT_SECONDS)
  const res: ChunkResult = { read: msgs.length, processed: 0, blocked: 0, failed: 0, dlq: 0, skipped: 0 }

  // Preflight the paid async path ONCE per chunk: if the FullEnrich webhook isn't reachable we skip
  // the async sweep entirely (no wasted credits). Cheap (one self-ping) and cached in the IO layer.
  const allowAsync = msgs.length > 0 ? await io.checkAsyncHealth() : false

  for (const m of msgs) {
    const { subscriberId, tenantId, jobId } = m.message

    // Poison guard FIRST: a message past MAX_READ_CT deliveries is dead-lettered before re-attempt.
    if (m.readCt > MAX_READ_CT) {
      await io.toDlq(m.msgId, m.message)
      if (jobId) await io.failJob(jobId, `enrichment exceeded ${MAX_READ_CT} attempts`)
      res.dlq++
      continue
    }

    try {
      const sub = await io.loadSubscriber(subscriberId, tenantId)
      if (!sub) {
        // Subscriber deleted between enqueue and processing — nothing to do, drop the message.
        // Still counts toward job completion (0044) or the job would hang 'running' forever.
        if (jobId) await io.accumulateJob(jobId, processedOnlyDelta())
        await io.archive(m.msgId)
        res.skipped++
        continue
      }

      const cascade = await io.loadCascade(tenantId)
      const checkpoint = await io.loadCheckpoint(subscriberId)
      // Stage-0 gate runs live here (cached-or-validate) before any paid provider is touched.
      const blocked = await io.ensureValidation(sub)

      const wf = await runWaterfall(
        { email: sub.email, name: sub.name, subscriberId, enrichmentPriority: sub.enrichmentPriority },
        {
          cascade,
          getProvider: k => io.getProvider(k, jobId),
          validationBlocks: blocked,
          allowAsync,
          seedMerged: checkpoint?.merged,
          seedProvenance: checkpoint?.provenance,
          seedAttempted: checkpoint?.attempted,
        },
      )

      // Persist BEFORE archive (idempotent on subscriber_id), but only when a provider actually
      // ran — a Stage-0 block writes nothing (the gate is re-evaluated from cache each run).
      if (wf.attempted.length > 0) {
        await io.persistEnrichment(buildEnrichmentRow(subscriberId, tenantId, wf, io.now()))
      }
      // Every handled message accumulates exactly one processed tick (0044 completion lifecycle) —
      // blocked and pure-checkpoint-retry deliveries included, else the job never flips 'completed'.
      // Money-path stats stay derived from providers that ran THIS delivery only (no double-charge).
      if (jobId) {
        const delta = wf.attempted.length > 0 ? jobDeltaFromResult(wf) : processedOnlyDelta()
        await io.accumulateJob(jobId, delta)
      }

      // Always enqueue scoring — Tier A/B signals don't need LinkedIn, so even blocked/miss
      // subscribers get a score (LinkedIn-absent simply records data_gap_linkedin).
      await io.enqueueScoring(subscriberId, tenantId)
      await io.archive(m.msgId)
      if (blocked) res.blocked++
      else res.processed++
    } catch (e) {
      // Leave the message: it reappears after vt and is retried; the poison guard dead-letters it
      // once read_ct exceeds MAX. Persisted partial state means the retry resumes, never re-charges.
      res.failed++
      res.lastError = String(e)
    }
  }
  return res
}

// ── Scoring chunk processor ──────────────────────────────────────────────────────
export async function processScoringChunk(io: ScoringWorkerIO): Promise<ChunkResult> {
  const msgs = await io.readChunk(SCORING_CHUNK_SIZE, SCORING_VT_SECONDS)
  const res: ChunkResult = { read: msgs.length, processed: 0, blocked: 0, failed: 0, dlq: 0, skipped: 0 }

  for (const m of msgs) {
    const { subscriberId, tenantId, referenceDate } = m.message

    if (m.readCt > MAX_READ_CT) {
      await io.toDlq(m.msgId, m.message)
      res.dlq++
      continue
    }

    try {
      const sub = await io.loadSubscriberForScoring(subscriberId, tenantId)
      if (!sub) {
        await io.archive(m.msgId)
        res.skipped++
        continue
      }
      const config = await io.loadScoringConfig(tenantId)
      const refDate = referenceDate ? new Date(referenceDate) : io.now()
      const record = buildRecordFromDb(sub)
      // V1 (Part 7): pass the subscriber's authoritative verification status. scoreRow no-ops for
      // unverified/expired/null, so this is inert until verification actually confirms a subscriber —
      // i.e. live scoring behaviour is unchanged today (all subscribers are unverified).
      const verification: VerificationSignalInput | undefined = sub.verification_status
        ? {
            status: sub.verification_status as SubscriberVerificationStatus,
            confidence: (sub.verification_confidence as Confidence | null) ?? null,
          }
        : undefined
      const result = scoreRow(record, config, refDate, verification)

      // subscriber_scores is append-only — a re-score from a retry or a later FullEnrich webhook
      // simply adds a newer row; the audit trail keeps every score.
      await io.insertScore({
        subscriber_id: subscriberId,
        tenant_id: tenantId,
        total_score: result.totalScore,
        confidence_tier: result.confidenceTier,
        tier_label: result.tierLabel,
        data_confidence: result.dataConfidence,
        primary_signal: result.primarySignal || null,
        supporting_signals: result.supportingSignals || null,
        signals_count: result.signalsCount,
        signals_fired: result.signalsFired || null,
        data_gaps: result.dataGaps || null,
        aec_professional_confirmed: result.aecProfessionalConfirmed,
        recommended_action: result.recommendedAction,
        scoring_version: result.scoringVersion,
        scored_at: refDate.toISOString(),
      })
      await io.archive(m.msgId)
      res.processed++
    } catch (e) {
      res.failed++
      res.lastError = String(e)
    }
  }
  return res
}
