/**
 * NSC EnrollmentVerify provider (Step 2, US) — STUB.
 * LYCERT_VERIFICATION_ARCHITECTURE.md Part 3 + Part 9.1.1 + Part 10.
 *
 * ⚠ DO NOT invent NSC's endpoint paths / auth / request+response schema — they are NOT public and come
 * with the NSC Web Services commercial agreement (Part 3.2 / Part 10). Until that contract is in hand,
 * NSC is stubbed behind the VerificationProvider interface (exactly as Part 10 instructs) and is seeded
 * DISABLED in verification_providers (0037), so it never enters the live waterfall.
 *
 * The stub is deliberately conservative: it returns UNABLE_TO_CONFIRM (never ENROLLED, never NOT_ENROLLED)
 * so that even if mis-enabled it can produce no adverse signal and fabricate no enrollment. When the
 * agreement lands, replace the body of verify() with the real client; the interface, the consent gate,
 * and the asymmetry rules around it do not change.
 */

import {
  type ConsentRecord,
  type VerificationProvider,
  type VerificationResult,
  type VerificationSubscriberInput,
  VerificationOutcome,
  makeVerificationResult,
} from '../base'

const PROVIDER_KEY = 'nsc'
const METHOD_CLASS = 'authoritative' as const

export function makeNscProvider(): VerificationProvider {
  return {
    providerKey: PROVIDER_KEY,
    methodClass: METHOD_CLASS,
    requiresConsent: true, // FERPA — no check without active, scoped, dated consent (Part 3.1 / Part 6.1)
    canAssertNotEnrolled: true, // authoritative source MAY assert NOT_ENROLLED (once the real client lands)
    async verify(_input: VerificationSubscriberInput, _consent: ConsentRecord | null): Promise<VerificationResult> {
      // Stub: no network call. Pending the NSC Web Services agreement + schema (Part 9.1.1).
      return makeVerificationResult(PROVIDER_KEY, METHOD_CLASS, VerificationOutcome.UNABLE_TO_CONFIRM, {
        errorMessage: 'NSC integration pending commercial agreement + Web Services schema (Part 9.1.1)',
      })
    },
  }
}
