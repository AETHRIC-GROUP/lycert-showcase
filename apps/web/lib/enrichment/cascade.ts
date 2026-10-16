/**
 * Registry-driven waterfall cascade — TS port of the core of orchestrator.py (Parts 2.x, 4.2).
 *
 * Pure decision logic: Stage 0 gating is resolved by the caller (cache/live ZeroBounce) and passed
 * in; providers are injected via getProvider; persistence/credit/scoring live in the worker (5d).
 * This keeps the cascade fully unit-testable and identical whether driven by a Next route or a
 * Supabase Edge Function worker.
 */
import {
  classifyCompleteness, ProviderOutcome, type CanonicalFields, type EnrichmentProvider,
} from './providers/base'
import { ENRICHMENT_PROVIDER_KEYS } from './providers'
import { mergeFields } from './merge'

export const ASYNC_PRIORITY_THRESHOLD = 40

export type CascadeStep = { providerKey: string; executionMode: 'sync' | 'async'; position: number }
export type AttemptedEntry = { provider: string; outcome: string }
export type ProviderStat = { attempts: number; hits: number; costUsd: number }

type ProviderRow = {
  provider_key: string
  provider_type: string
  execution_mode: 'sync' | 'async'
  enabled: boolean
  default_position: number | null
}
type OverrideRow = { provider_key: string; position: number; enabled: boolean }

/** Build the ordered enrichment cascade from registry rows + tenant overrides (Part 4.2).
 * Validation-type providers, disabled, null-position, and unknown keys are excluded. */
export function buildCascade(providers: ProviderRow[], overrides: OverrideRow[] = []): CascadeStep[] {
  const ovMap = new Map(overrides.map(o => [o.provider_key, o]))
  const steps: CascadeStep[] = []
  for (const p of providers) {
    if (p.provider_type !== 'enrichment') continue
    if (!ENRICHMENT_PROVIDER_KEYS.includes(p.provider_key as never)) continue
    const ov = ovMap.get(p.provider_key)
    const enabled = ov ? ov.enabled : p.enabled
    if (!enabled) continue
    const position = ov ? ov.position : p.default_position
    if (position == null) continue
    steps.push({ providerKey: p.provider_key, executionMode: p.execution_mode, position })
  }
  steps.sort((a, b) => a.position - b.position)
  return steps
}

export function majorityProvider(provenance: Record<string, string>, fallback: string): string {
  const counts: Record<string, number> = {}
  for (const v of Object.values(provenance)) counts[v] = (counts[v] ?? 0) + 1
  let best = fallback
  let max = 0
  for (const [k, n] of Object.entries(counts)) if (n > max) { max = n; best = k }
  return best
}

export function needsAsyncSweep(merged: CanonicalFields, enrichmentPriority: number): boolean {
  if (classifyCompleteness(merged) === ProviderOutcome.COMPLETE) return false
  return (enrichmentPriority ?? 0) >= ASYNC_PRIORITY_THRESHOLD
}

export type WaterfallInput = {
  email: string
  name: string | null
  subscriberId: string
  enrichmentPriority: number
}

export type WaterfallResult = {
  merged: CanonicalFields
  provenance: Record<string, string>
  attempted: AttemptedEntry[]
  completeness: ProviderOutcome
  pendingProvider: string | null
  /** Provider async job id for the pending sweep (FullEnrich enrichment_id), so a lost webhook can be
   * recovered by polling. Null unless pendingProvider is set this run. */
  pendingReference: string | null
  blocked: boolean
  stats: Record<string, ProviderStat>
}

export type RunWaterfallOpts = {
  cascade: CascadeStep[]
  /** Construct/return the provider for a key (sync clients + the async FullEnrich client). */
  getProvider: (key: string) => EnrichmentProvider | null
  /** Stage 0 result resolved by the caller (cached or live). When true, the cascade is skipped. */
  validationBlocks: boolean
  /** Whether the paid async sweep (FullEnrich) may fire. The worker sets this false when the webhook
   * receiver isn't reachable (placeholder/down/bad token) so we never pay for results that can't come
   * back. Skipped — not attempted — so it retries on a later run once the path is healthy. Default true. */
  allowAsync?: boolean
  /** Checkpoint state from a prior attempt (queue retry) — providers already attempted are skipped,
   * so a retry never re-charges. Their fields are pre-seeded into merged/provenance. */
  seedMerged?: CanonicalFields
  seedProvenance?: Record<string, string>
  seedAttempted?: AttemptedEntry[]
}

function accumulate(stats: Record<string, ProviderStat>, key: string, hit: boolean, costUsd: number): void {
  const e = (stats[key] ??= { attempts: 0, hits: 0, costUsd: 0 })
  e.attempts += 1
  if (hit) e.hits += 1
  e.costUsd = Math.round((e.costUsd + (costUsd || 0)) * 10000) / 10000
}

/** Run the sync cascade (stop-on-COMPLETE, merge) then the async handoff. Pure — no IO/persistence. */
export async function runWaterfall(input: WaterfallInput, opts: RunWaterfallOpts): Promise<WaterfallResult> {
  const stats: Record<string, ProviderStat> = {}
  if (opts.validationBlocks) {
    return { merged: {}, provenance: {}, attempted: [], completeness: ProviderOutcome.MISS, pendingProvider: null, pendingReference: null, blocked: true, stats }
  }

  const merged: CanonicalFields = { ...(opts.seedMerged ?? {}) }
  const provenance: Record<string, string> = { ...(opts.seedProvenance ?? {}) }
  const attempted: AttemptedEntry[] = [...(opts.seedAttempted ?? [])]
  const alreadyAttempted = new Set(attempted.map(a => a.provider))
  let pendingProvider: string | null = null
  let pendingReference: string | null = null

  for (const step of opts.cascade) {
    if (step.executionMode === 'async') {
      // Skip (don't attempt) when the caller disables async — leaves it retryable once healthy.
      if (opts.allowAsync !== false && needsAsyncSweep(merged, input.enrichmentPriority) && !alreadyAttempted.has(step.providerKey)) {
        const provider = opts.getProvider(step.providerKey)
        if (provider) {
          const result = await provider.enrich(input.email, input.name, input.subscriberId)
          if (result.outcome === ProviderOutcome.PENDING && result.asyncReference) {
            pendingProvider = step.providerKey
            pendingReference = result.asyncReference
            attempted.push({ provider: step.providerKey, outcome: 'pending' })
          }
        }
      }
      break // async is always terminal in the sync loop
    }

    if (alreadyAttempted.has(step.providerKey)) continue // checkpoint: don't re-charge on retry
    const provider = opts.getProvider(step.providerKey)
    if (!provider) continue

    const result = await provider.enrich(input.email, input.name, input.subscriberId)
    const hit = result.outcome === ProviderOutcome.COMPLETE || result.outcome === ProviderOutcome.PARTIAL
    accumulate(stats, step.providerKey, hit, result.charged ? result.costUsd : 0)

    const status = mergeFields(merged, provenance, result, input.name)
    attempted.push({ provider: step.providerKey, outcome: status === 'mismatch' ? 'mismatch' : result.outcome })

    if (classifyCompleteness(merged) === ProviderOutcome.COMPLETE) break
  }

  return {
    merged, provenance, attempted,
    completeness: classifyCompleteness(merged),
    pendingProvider, pendingReference, blocked: false, stats,
  }
}
