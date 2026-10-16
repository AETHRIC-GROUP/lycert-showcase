/**
 * Verification waterfall orchestrator — LYCERT_VERIFICATION_ARCHITECTURE.md Part 2.
 *
 * Per subscriber, attempt providers in order; STOP at the first terminal confirmation (Part 2). Mirrors
 * the enrichment cascade's pure/deps-injected shape (worker.ts is pure; worker-io.ts binds Supabase), so
 * the legal rules are unit-testable without a DB, an email send, or an external API.
 *
 * It enforces, in code:
 *   - Method availability gate (Step 1 institution resolution → which methods are even possible:
 *     country scope for authoritative sources, institutional email for the email-loop, etc.).
 *   - Consent gate (Part 6.1): a requires_consent provider with no active consent is SKIPPED, not failed.
 *   - The asymmetry safety invariant (Part 2.1 / Part 5): a NON-authoritative provider can NEVER assert
 *     NOT_ENROLLED — if one does, it is defensively downgraded to UNABLE_TO_CONFIRM.
 *   - Stop-on-terminal, and an exhausted waterfall = UNVERIFIED (NOT "ineligible" — Part 2).
 */

import {
  type ConsentRecord,
  type Confidence,
  type SubscriberVerificationStatus,
  type VerificationProvider,
  type VerificationResult,
  type VerificationSubscriberInput,
  VerificationOutcome,
  isTerminal,
  makeVerificationResult,
  statusFromOutcome,
} from './base'
import { checkConsentGate } from './consent'

/** Why a provider did not run (recorded for the audit trail; never adverse). */
export type SkipReason = 'method_not_applicable' | 'no_consent' | 'revoked' | 'expired' | 'disabled'

export interface VerificationAttempt {
  providerKey: string
  ran: boolean
  skipReason?: SkipReason
  result?: VerificationResult
}

export interface WaterfallOutcome {
  /** The terminal result that ended the waterfall, or null if exhausted (→ unverified). */
  winner: VerificationResult | null
  attempts: VerificationAttempt[]
  subscriberStatus: SubscriberVerificationStatus
  confidence: Confidence | null
}

export interface OrchestratorDeps {
  now: () => Date
  /** Step 1 method-availability gate: is this method even possible for this subscriber?
   * (authoritative source covers the country; subscriber has an institutional email for the loop; etc.) */
  isApplicable: (provider: VerificationProvider, input: VerificationSubscriberInput) => boolean | Promise<boolean>
  /** Active-consent lookup for a consent-gated provider (returns null when none on file). */
  getActiveConsent: (
    provider: VerificationProvider,
    input: VerificationSubscriberInput,
  ) => Promise<ConsentRecord | null>
}

/**
 * Run the ordered waterfall. `providers` MUST already be filtered to enabled rows and sorted by
 * default_position (the IO layer does that from verification_providers).
 */
export async function runVerificationWaterfall(
  providers: VerificationProvider[],
  input: VerificationSubscriberInput,
  deps: OrchestratorDeps,
): Promise<WaterfallOutcome> {
  const attempts: VerificationAttempt[] = []
  const now = deps.now()

  for (const provider of providers) {
    // 1. Method availability (Step 1).
    const applicable = await deps.isApplicable(provider, input)
    if (!applicable) {
      attempts.push({ providerKey: provider.providerKey, ran: false, skipReason: 'method_not_applicable' })
      continue
    }

    // 2. Consent gate (Part 6.1) — skip, never fail.
    const consent = provider.requiresConsent ? await deps.getActiveConsent(provider, input) : null
    const gate = checkConsentGate(provider, consent, now)
    if (!gate.allowed) {
      attempts.push({ providerKey: provider.providerKey, ran: false, skipReason: gate.reason })
      continue
    }

    // 3. Run the provider.
    let result = await provider.verify(input, consent)

    // 4. Safety invariant: only authoritative providers may assert NOT_ENROLLED (Part 2.1 / Part 5).
    if (result.outcome === VerificationOutcome.NOT_ENROLLED && !provider.canAssertNotEnrolled) {
      result = makeVerificationResult(provider.providerKey, result.methodClass, VerificationOutcome.UNABLE_TO_CONFIRM, {
        rawReference: result.rawReference,
        consentId: result.consentId,
        errorMessage:
          `downgraded: ${provider.providerKey} (method_class=${result.methodClass}) cannot assert NOT_ENROLLED` +
          (result.errorMessage ? `; ${result.errorMessage}` : ''),
      })
    }

    attempts.push({ providerKey: provider.providerKey, ran: true, result })

    // 5. Stop at the first terminal outcome.
    if (isTerminal(result.outcome)) {
      return {
        winner: result,
        attempts,
        subscriberStatus: statusFromOutcome(result.outcome),
        confidence: result.confidence,
      }
    }
    // Non-terminal (unable_to_confirm / error) → fall through to the next method.
  }

  // Exhausted with no terminal confirmation → UNVERIFIED (not ineligible).
  return { winner: null, attempts, subscriberStatus: 'unverified', confidence: null }
}
