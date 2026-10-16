/**
 * Provider abstraction for the ENROLLMENT VERIFICATION layer —
 * LYCERT_VERIFICATION_ARCHITECTURE.md Part 5 (TS port of the doc's Python `VerificationProvider`).
 *
 * This layer is SEPARATE from enrichment (Part 0). Enrichment answers "who is this person
 * professionally?" (indicative, LinkedIn-derived). Verification answers "is this person actually still
 * enrolled?" (authoritative: registrar/clearinghouse/SSO/email-loop/document). A compliance decision
 * must rest on THIS layer, never on enrichment alone.
 *
 * The legal asymmetry (Part 2.1 / Part 6.3) is encoded here once so every caller shares it:
 *   - ENROLLED / CONTROL_PROVEN  → exculpatory; subscriber stays on EDU.
 *   - NOT_ENROLLED               → adverse, BUT only authoritative providers may assert it, and it still
 *                                  passes the human-in-the-loop adverse-action gate (never auto-action).
 *   - UNABLE_TO_CONFIRM / ERROR / DOCUMENT_PENDING → NEVER adverse. Absence of confirmation is not
 *                                  evidence of ineligibility.
 */

/** Outcome of a single verification attempt. Values are identical to the DB `status` strings
 * (verification_results.status), so an outcome maps straight to a stored status. */
export enum VerificationOutcome {
  ENROLLED = 'enrolled',
  NOT_ENROLLED = 'not_enrolled', // ONLY authoritative providers may return this
  CONTROL_PROVEN = 'control_proven', // email-loop / SSO success (current account/inbox control)
  UNABLE_TO_CONFIRM = 'unable_to_confirm',
  DOCUMENT_PENDING = 'document_pending',
  ERROR = 'error',
}

export type MethodClass = 'authoritative' | 'semi_authoritative' | 'document'
export type Confidence = 'authoritative' | 'semi_authoritative' | 'medium' | 'low'

/** Authoritative enrollment status carried on the subscriber row (0040). Distinct from enrichment. */
export type SubscriberVerificationStatus =
  | 'verified_enrolled'
  | 'verified_not_enrolled'
  | 'unverified'
  | 'verification_expired'

/** Normalised subscriber input the verification waterfall operates on. */
export interface VerificationSubscriberInput {
  subscriberId: string
  tenantId: string
  email: string | null
  name: string | null
  institutionName: string | null
  institutionCountry: string | null // resolved ISO country code (Step 1 institution resolution)
  statedGraduationDate: string | null // ISO date; used by the email-loop false-positive control (Part 8.1)
}

/** An active consent row (Part 6.1). Only fields the verification code needs. */
export interface ConsentRecord {
  id: string
  scope: string
  purpose: string
  recipient: string
  consentTextVersion: string
  grantedAt: string
  revokedAt: string | null
  expiresAt: string | null
}

/** Result of one verification attempt — the RESULT only, never the underlying education-record payload
 * (Part 6.2 / Part 10): no transcripts, GPA, courses. `rawReference` is a provider request id only. */
export interface VerificationResult {
  providerKey: string
  methodClass: MethodClass
  outcome: VerificationOutcome
  confidence: Confidence
  enrollmentStatus: string | null // full-time/half-time/etc. when the source provides it
  enrollmentEndDate: string | null // ISO date when the source provides it
  asOfDate: string | null // the date the source's data is current to
  rawReference: string | null // provider request id ONLY — NEVER a raw PII payload
  consentId: string | null
  errorMessage: string | null
}

export function makeVerificationResult(
  providerKey: string,
  methodClass: MethodClass,
  outcome: VerificationOutcome,
  opts: Partial<Omit<VerificationResult, 'providerKey' | 'methodClass' | 'outcome'>> = {},
): VerificationResult {
  return {
    providerKey,
    methodClass,
    outcome,
    confidence: opts.confidence ?? defaultConfidenceFor(methodClass, outcome),
    enrollmentStatus: opts.enrollmentStatus ?? null,
    enrollmentEndDate: opts.enrollmentEndDate ?? null,
    asOfDate: opts.asOfDate ?? null,
    rawReference: opts.rawReference ?? null,
    consentId: opts.consentId ?? null,
    errorMessage: opts.errorMessage ?? null,
  }
}

/** Confidence defaults from the method class (Part 2 / Part 7 trust ordering). Document review is MEDIUM
 * (documents can be stale/forged); a non-terminal outcome from any method is LOW. */
export function defaultConfidenceFor(methodClass: MethodClass, outcome: VerificationOutcome): Confidence {
  if (!isTerminal(outcome)) return 'low'
  if (methodClass === 'document') return 'medium'
  return methodClass // 'authoritative' | 'semi_authoritative'
}

/** Every verification provider implements this (mirrors enrichment's EnrichmentProvider). */
export interface VerificationProvider {
  providerKey: string
  methodClass: MethodClass
  requiresConsent: boolean
  /** Only authoritative providers may set this true (NSC/HEDD/SSO). Enforced defensively by the
   * orchestrator: a non-authoritative provider that returns NOT_ENROLLED is downgraded. */
  canAssertNotEnrolled: boolean
  verify(input: VerificationSubscriberInput, consent: ConsentRecord | null): Promise<VerificationResult>
}

// ── Legal asymmetry helpers (Part 2.1) — the spine of the layer ──────────────────────────────────────

/** A terminal outcome ends the waterfall for this subscriber (a confirmation, refutation, or a pending
 * interactive/document step that we wait on). Non-terminal outcomes fall through to the next method. */
export function isTerminal(outcome: VerificationOutcome): boolean {
  return (
    outcome === VerificationOutcome.ENROLLED ||
    outcome === VerificationOutcome.NOT_ENROLLED ||
    outcome === VerificationOutcome.CONTROL_PROVEN ||
    outcome === VerificationOutcome.DOCUMENT_PENDING
  )
}

/** Only an authoritative NOT_ENROLLED is adverse. Everything else is exculpatory or neutral. Absence of
 * confirmation (UNABLE_TO_CONFIRM / ERROR / DOCUMENT_PENDING) is NEVER adverse (Part 2.1 / Part 10). */
export function isAdverse(outcome: VerificationOutcome): boolean {
  return outcome === VerificationOutcome.NOT_ENROLLED
}

/** Maps a terminal outcome to the subscriber's authoritative verification_status (Part 5 / Part 7). */
export function statusFromOutcome(outcome: VerificationOutcome): SubscriberVerificationStatus {
  switch (outcome) {
    case VerificationOutcome.ENROLLED:
    case VerificationOutcome.CONTROL_PROVEN:
      return 'verified_enrolled'
    case VerificationOutcome.NOT_ENROLLED:
      return 'verified_not_enrolled'
    default:
      // unable_to_confirm / error / document_pending → not a status change; stays unverified.
      return 'unverified'
  }
}
