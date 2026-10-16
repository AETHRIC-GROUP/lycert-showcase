/**
 * Verification queue worker (pure) — LYCERT_VERIFICATION_ARCHITECTURE.md Part 2 + Part 9.2 step 6.
 *
 * Drains verification_q in bounded chunks, exactly mirroring the enrichment worker's pgmq retry/DLQ
 * contract (read hides for vt; SUCCESS→archive; TRANSIENT→reappear; POISON past MAX_READ_CT→DLQ).
 * The orchestration is PURE over the injected VerificationWorkerIO so the legal rules (asymmetry,
 * consent gate, stale-alumni elevated review, re-verify cadence) are unit-testable without a DB.
 *
 * Per subscriber: resolve institution (Step 1) → run the waterfall → persist every attempt that ran
 * (audit) → set the subscriber's authoritative verification_status from the terminal winner. Absence
 * of confirmation never writes an adverse status (Part 2.1).
 */

import {
  type QueueMessage,
} from '../enrichment/queue'
import {
  type ConsentRecord,
  type SubscriberVerificationStatus,
  type VerificationProvider,
  type VerificationResult,
  type VerificationSubscriberInput,
  VerificationOutcome,
} from './base'
import { isStaleAlumniRisk } from './providers/email-loop'
import { methodApplicable, type ProviderApplicability, type ResolvedInstitution } from './institution'
import { runVerificationWaterfall, type WaterfallOutcome } from './orchestrator'

export const VERIFICATION_CHUNK_SIZE = 50
export const VERIFICATION_VT_SECONDS = 60
export const VERIFICATION_MAX_READ_CT = 5

// Re-verification cadence anchor (Part 9.3): how long an authoritative confirmation is trusted before
// the lifecycle engine re-checks. Authoritative sources are stable term-to-term; semi-authoritative
// (email-loop control) is shorter because inbox control drifts faster than registrar records.
const REVERIFY_DAYS: Record<'authoritative' | 'semi_authoritative' | 'medium' | 'low', number> = {
  authoritative: 180,
  semi_authoritative: 90,
  medium: 60,
  low: 30,
}

export type VerificationJobMsg = { subscriberId: string; tenantId: string }

/** The patch the IO layer applies to the subscriber row from a terminal outcome. */
export type SubscriberVerificationPatch = {
  status: SubscriberVerificationStatus
  method: string | null
  confidence: string | null
  verifiedAt: string | null
  verificationExpiresAt: string | null
}

export interface VerificationWorkerIO {
  readChunk(qty: number, vt: number): Promise<QueueMessage<VerificationJobMsg>[]>
  archive(msgId: number): Promise<void>
  toDlq(msgId: number, message: VerificationJobMsg): Promise<void>
  loadSubscriberInput(subscriberId: string, tenantId: string): Promise<VerificationSubscriberInput | null>
  /** Enabled verification providers for this tenant, ordered by default_position. */
  loadProviders(tenantId: string): Promise<VerificationProvider[]>
  /** Step-1 institution resolution (reuses the academic_domains reference set). */
  resolveInstitution(input: VerificationSubscriberInput): Promise<ResolvedInstitution>
  /** Availability metadata (country_scope) for a provider, from its verification_providers row. */
  providerMeta(providerKey: string): ProviderApplicability | null
  /** Active, unexpired, unrevoked consent for a consent-gated provider, or null. */
  getActiveConsent(provider: VerificationProvider, input: VerificationSubscriberInput): Promise<ConsentRecord | null>
  /** Persist one attempt's RESULT (never PII payload) to verification_results. */
  persistResult(subscriberId: string, tenantId: string, result: VerificationResult, now: Date): Promise<void>
  /** Apply the authoritative verification_status patch to the subscriber. */
  updateSubscriber(subscriberId: string, tenantId: string, patch: SubscriberVerificationPatch): Promise<void>
  now(): Date
}

export type VChunkResult = { read: number; processed: number; failed: number; dlq: number; lastError?: string }

/**
 * Decide the subscriber patch from a finished waterfall, or `null` when the subscriber's stored status
 * must be LEFT UNTOUCHED.
 *
 * Critical (re-verification is the product differentiator, Part 1.2): a run that does not produce a
 * terminal confirmation must NOT overwrite a previously-stored status. "Exhausted = unverified" (Part 2)
 * describes THIS run's result, not a mandate to wipe durable state — re-running verification on an
 * already-verified subscriber and getting no fresh confirmation must never reset them to unverified.
 * So no-winner / stale-alumni / non-status-changing outcomes all return null (no write). (Transitioning
 * a stale confirmation to `verification_expired` past `verification_expires_at` is the lifecycle engine's
 * job — Part 9.3, deferred — not the per-run worker's.)
 *
 * The stale-alumni control (Part 8.1) lives here: a control_proven email-loop pass on a subscriber whose
 * graduation is years past does NOT clear them — an alumni-retained inbox can pass the loop — so we leave
 * their status untouched (enrichment-driven elevated review) while still recording the result for audit.
 */
export function patchFromOutcome(
  out: WaterfallOutcome,
  input: VerificationSubscriberInput,
  now: Date,
): SubscriberVerificationPatch | null {
  const winner = out.winner
  if (!winner) return null

  // Stale-alumni elevated-review guard: only-email-loop control on a long-graduated subscriber → leave
  // status untouched (do NOT promote to verified_enrolled, which would cap suspicion below Tier-2).
  if (
    winner.providerKey === 'email_loop' &&
    winner.outcome === VerificationOutcome.CONTROL_PROVEN &&
    isStaleAlumniRisk(input.statedGraduationDate, now)
  ) {
    return null
  }

  if (out.subscriberStatus === 'unverified') return null

  const ms = REVERIFY_DAYS[winner.confidence] * 24 * 60 * 60 * 1000
  return {
    status: out.subscriberStatus,
    method: winner.providerKey,
    confidence: winner.confidence,
    verifiedAt: now.toISOString(),
    verificationExpiresAt: new Date(now.getTime() + ms).toISOString(),
  }
}

export async function processVerificationChunk(io: VerificationWorkerIO): Promise<VChunkResult> {
  const res: VChunkResult = { read: 0, processed: 0, failed: 0, dlq: 0 }
  const msgs = await io.readChunk(VERIFICATION_CHUNK_SIZE, VERIFICATION_VT_SECONDS)
  res.read = msgs.length

  for (const m of msgs) {
    const { subscriberId, tenantId } = m.message
    // Poison guard: route to the DLQ before re-attempting so a stuck message can't loop forever.
    if (m.readCt > VERIFICATION_MAX_READ_CT) {
      await io.toDlq(m.msgId, m.message)
      res.dlq++
      continue
    }
    try {
      const input = await io.loadSubscriberInput(subscriberId, tenantId)
      if (!input) {
        // Nothing to verify (deleted subscriber, etc.) — drop it, don't retry forever.
        await io.archive(m.msgId)
        res.processed++
        continue
      }

      const providers = await io.loadProviders(tenantId)
      const resolved = await io.resolveInstitution(input)
      const now = io.now()

      const out = await runVerificationWaterfall(providers, input, {
        now: io.now,
        isApplicable: (provider, i) => {
          const meta = io.providerMeta(provider.providerKey)
          if (!meta) return true // no metadata → don't block; the provider itself gates
          return methodApplicable(meta, i, resolved)
        },
        getActiveConsent: io.getActiveConsent,
      })

      // Persist every attempt that actually ran (audit trail; result-only, never PII).
      for (const attempt of out.attempts) {
        if (attempt.ran && attempt.result) {
          await io.persistResult(subscriberId, tenantId, attempt.result, now)
        }
      }

      // Only write when there is a status change to make — a no-confirmation run must never clobber a
      // previously-stored verified status (re-verification, Part 1.2).
      const patch = patchFromOutcome(out, input, now)
      if (patch) await io.updateSubscriber(subscriberId, tenantId, patch)
      await io.archive(m.msgId)
      res.processed++
    } catch (e) {
      // Transient failure: leave the message to reappear after vt (retry). Never archive on error.
      res.failed++
      res.lastError = String(e)
    }
  }
  return res
}
