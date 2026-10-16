/**
 * V1 — authoritative-enrollment scoring signal (LYCERT_VERIFICATION_ARCHITECTURE.md Part 7).
 *
 * Verification OUTRANKS enrichment on the enrollment question (trust ordering: authoritative >
 * semi-authoritative > enrichment (LinkedIn-derived) > self-reported). V1 is applied by the scoring
 * engine as an optional input:
 *   - verified_enrolled (authoritative OR semi)  → strong EXCULPATORY: overrides the LinkedIn-derived
 *     C3 signal and caps total suspicion strictly BELOW the Tier-2 threshold (can never be Tier 1/2).
 *   - verified_not_enrolled (authoritative only) → strongly INCULPATORY, but routes to HUMAN REVIEW
 *     (never auto-action — Part 6.3); the enrichment score stands, the recommended action changes.
 *   - unverified / verification_expired / absent  → V1 contributes EXACTLY 0 (complete no-op). This is
 *     the safety property the CEDS regression depends on: with no verification, scoring is unchanged.
 */

import type { Confidence, SubscriberVerificationStatus } from '../verification/base'

export interface VerificationSignalInput {
  status: SubscriberVerificationStatus
  confidence: Confidence | null
}

/** Recommended-action label for a verified-not-enrolled subscriber (always human-gated, never auto). */
export const V1_NOT_ENROLLED_ACTION = 'Human Review — Verified Not Enrolled'

/** True only when V1 should modify scoring. unverified / verification_expired / absent → no-op. */
export function v1Active(v: VerificationSignalInput | undefined | null): v is VerificationSignalInput {
  return !!v && (v.status === 'verified_enrolled' || v.status === 'verified_not_enrolled')
}
