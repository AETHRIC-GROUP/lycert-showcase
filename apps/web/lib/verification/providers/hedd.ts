/**
 * HEDD (UK) verification provider (Step 2, GB) — STUB.
 * LYCERT_VERIFICATION_ARCHITECTURE.md Part 4 + Part 9.1 + Part 10.
 *
 * HEDD (Higher Education Degree Datacheck, Jisc/Prospects) is a paid, consent-based, per-check UK
 * degree/enrolment source. Like NSC, the integration shape is NOT public — it comes with the HEDD
 * account/agreement (Part 4). Until that is in hand, HEDD is stubbed behind the VerificationProvider
 * interface and seeded DISABLED in verification_providers (0037), so it never enters the live waterfall.
 *
 * The stub returns UNABLE_TO_CONFIRM (never ENROLLED, never NOT_ENROLLED) so that even if mis-enabled it
 * can produce no adverse signal and fabricate no enrollment. When the agreement lands, replace verify()'s
 * body with the real client; the interface, consent gate, and asymmetry rules around it do not change.
 */

import {
  type ConsentRecord,
  type VerificationProvider,
  type VerificationResult,
  type VerificationSubscriberInput,
  VerificationOutcome,
  makeVerificationResult,
} from '../base'

const PROVIDER_KEY = 'hedd'
const METHOD_CLASS = 'authoritative' as const

export function makeHeddProvider(): VerificationProvider {
  return {
    providerKey: PROVIDER_KEY,
    methodClass: METHOD_CLASS,
    requiresConsent: true, // consent-based, per HEDD's terms (Part 4)
    canAssertNotEnrolled: true, // authoritative source MAY assert NOT_ENROLLED (once the real client lands)
    async verify(_input: VerificationSubscriberInput, _consent: ConsentRecord | null): Promise<VerificationResult> {
      // Stub: no network call. Pending the HEDD account + agreement + schema (Part 4 / Part 9.1).
      return makeVerificationResult(PROVIDER_KEY, METHOD_CLASS, VerificationOutcome.UNABLE_TO_CONFIRM, {
        errorMessage: 'HEDD integration pending account + commercial agreement (Part 4)',
      })
    },
  }
}
