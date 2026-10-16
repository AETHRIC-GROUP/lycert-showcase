/**
 * FullEnrich webhook — PURE core (no IO), so the merge / idempotency / job-accounting logic is
 * unit-testable with plain objects. The route (app/api/enrichment/webhook/fullenrich) verifies the
 * signature, loads the existing subscriber_enrichment row, calls applyFullenrichResult, then persists
 * + accumulates job stats + re-enqueues scoring.
 *
 * FullEnrich is the async final sweep (V2 §1.6): we SUBMIT during the cascade (marking the subscriber
 * pending_async_provider='fullenrich') and its result lands here, minutes later, via webhook.
 *
 * Idempotency (V2 §4.3): the subscriber's own `pending_async_provider` column IS the dedupe key — we
 * only apply a result while it equals 'fullenrich', then clear it. A duplicate/retried delivery finds
 * it already null and is skipped, so we never double-merge or double-charge. No extra table needed.
 */
import { CANONICAL_ENRICHMENT_FIELDS, classifyCompleteness, stripToCanonical, type CanonicalFields } from './providers/base'
import { mergeFields } from './merge'
import { majorityProvider, type AttemptedEntry } from './cascade'
import type { WebhookResultItem } from './providers/fullenrich'

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
const FULLENRICH_COST_PER_SUCCESS = 0.05

/** The subset of a subscriber_enrichment row this logic reads. */
export type ExistingEnrichment = Record<string, unknown> & {
  field_provenance?: Record<string, string> | null
  providers_attempted?: AttemptedEntry[] | null
  pending_async_provider?: string | null
  enrichment_provider?: string | null
}

export type FullenrichJobDelta = {
  perProvider: Record<string, { attempts: number; hits: number; cost_usd: number }>
  success: number
  miss: number
  costUsd: number
  /** Negative: the submit-time +1 async_pending is now resolved. */
  asyncPending: number
}

export type ApplyResult =
  | { status: 'no_existing_row' }
  | { status: 'skipped_not_pending' }
  | { status: 'applied'; update: Record<string, unknown>; delta: FullenrichJobDelta; matched: boolean }

/**
 * Apply one FullEnrich webhook result to the subscriber's existing enrichment row.
 * Returns the column updates to persist + the job-accounting delta, or a skip status.
 */
export function applyFullenrichResult(
  existing: ExistingEnrichment | null,
  item: WebhookResultItem,
  subscriberName: string | null,
  now: Date = new Date(),
): ApplyResult {
  // A FullEnrich result should only arrive for a subscriber we marked pending. No row → nothing to
  // merge into (submission always persists the pending row first); treat as a no-op we can log.
  if (!existing) return { status: 'no_existing_row' }

  // Idempotency guard: only the delivery that finds the subscriber still pending on fullenrich does
  // work. Replays / late duplicates find it cleared and are skipped — no double-merge, no double-charge.
  if (existing.pending_async_provider !== 'fullenrich') return { status: 'skipped_not_pending' }

  // Reconstruct the merged state from the persisted row (canonical fields + provenance).
  const merged: CanonicalFields = {}
  for (const f of Array.from(CANONICAL_ENRICHMENT_FIELDS)) {
    if (existing[f] != null) merged[f] = existing[f]
  }
  const provenance: Record<string, string> = { ...(existing.field_provenance ?? {}) }

  // Gap-fill merge (Part 5). profile.full_name (when present) feeds the wrong-person guard; when
  // absent, names_overlap returns true (FullEnrich matches by email anyway).
  mergeFields(merged, provenance, { providerKey: 'fullenrich', fields: item.fields, fullName: item.fullName }, subscriberName)

  const ownOutcome = classifyCompleteness(item.fields)
  const attempted: AttemptedEntry[] = [
    ...(existing.providers_attempted ?? []),
    { provider: 'fullenrich', outcome: item.matched ? ownOutcome : 'miss' },
  ]

  const update: Record<string, unknown> = {
    ...stripToCanonical(merged),
    field_provenance: provenance,
    providers_attempted: attempted,
    completeness: classifyCompleteness(merged),
    pending_async_provider: null, // clears the idempotency flag
    enrichment_provider: majorityProvider(provenance, existing.enrichment_provider ?? 'fullenrich'),
    enriched_at: now.toISOString(),
    delete_at: new Date(now.getTime() + THIRTY_DAYS_MS).toISOString(),
  }

  const delta: FullenrichJobDelta = item.matched
    ? { perProvider: { fullenrich: { attempts: 1, hits: 1, cost_usd: FULLENRICH_COST_PER_SUCCESS } }, success: 1, miss: 0, costUsd: FULLENRICH_COST_PER_SUCCESS, asyncPending: -1 }
    : { perProvider: { fullenrich: { attempts: 1, hits: 0, cost_usd: 0 } }, success: 0, miss: 1, costUsd: 0, asyncPending: -1 }

  return { status: 'applied', update, delta, matched: item.matched }
}

/**
 * Resolve a subscriber stuck pending on FullEnrich past the timeout (no webhook ever arrived).
 * Clears the pending flag and records a 'timeout' attempt so it never blocks future re-enrichment and
 * isn't mistaken for in-flight. Returns null if the row isn't actually pending on fullenrich.
 * No job-stat delta: the enrichment row carries no job_id, so async_pending can't be attributed back
 * to a specific job here (a soft counter; the completion lifecycle is wired separately).
 */
export function resolveTimedOutPending(existing: ExistingEnrichment): { update: Record<string, unknown> } | null {
  if (existing.pending_async_provider !== 'fullenrich') return null
  return {
    update: {
      pending_async_provider: null,
      providers_attempted: [...(existing.providers_attempted ?? []), { provider: 'fullenrich', outcome: 'timeout' }],
    },
  }
}
