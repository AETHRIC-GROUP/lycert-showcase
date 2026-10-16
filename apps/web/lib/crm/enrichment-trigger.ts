/**
 * Pure enrichment-trigger decision (Bridge Part 9): "only EDU contacts approaching/after estimated
 * graduation, or flagged by score, or manual." Reuses the EXISTING lifecycle_stage computation (the
 * lifecycle engine already classifies "approaching/past graduation") and confidence_tier (CEDS: 0 =
 * Likely Clean, 1-3 = flagged) rather than inventing a new date-threshold or score formula.
 *
 * "Respects existing monthly budget caps" (Bridge's own words) describes an ASSUMED constraint — no
 * monthly spend-cap enforcement exists anywhere in the enrichment pipeline today (V2 never built one).
 * Building that is out of scope for M2 (not asked for in the M2 bullet list, which only says "enrichment
 * triggered per Part 9"). The safeguard actually implemented here is narrower but concrete: only trigger
 * automatically for a subscriber that has NEVER been enriched (`lastEnrichedAt === null`) — bounded,
 * one-shot-per-subscriber spend, not unbounded re-triggering on every webhook. Flagged in DECISIONS.md.
 */

const QUALIFYING_LIFECYCLE_STAGES = new Set(['approaching_graduation', 'post_graduation_unverified', 're_verification_pending'])

export interface EnrichmentTriggerInput {
  lifecycleStage: string
  confidenceTier: number | null // null = never scored
  lastEnrichedAt: string | null // null = never enriched
}

/** True only for a subscriber that both qualifies AND has never been auto-enriched before. */
export function shouldAutoTriggerEnrichment(input: EnrichmentTriggerInput): boolean {
  if (input.lastEnrichedAt !== null) return false // the one-shot-per-subscriber safeguard
  const nearOrPastGraduation = QUALIFYING_LIFECYCLE_STAGES.has(input.lifecycleStage)
  const scoreFlagged = input.confidenceTier !== null && input.confidenceTier > 0
  return nearOrPastGraduation || scoreFlagged
}
