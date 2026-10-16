/**
 * Document-review verification provider (Step 5) — the waterfall wrapper.
 * LYCERT_DOCUMENT_REVIEW_ARCHITECTURE.md Part 6 + LYCERT_VERIFICATION_ARCHITECTURE.md Part 2 Step 5.
 *
 * Maps the subscriber's latest reviewed document → a waterfall outcome (DOCUMENT_PENDING while a human is
 * still reviewing; ENROLLED@medium on approve; UNABLE_TO_CONFIRM otherwise — a document can never REFUTE
 * enrollment, image-only). DORMANT by default: the registry seeds `document` DISABLED and no review-lookup
 * dep is wired, so verify() returns UNABLE_TO_CONFIRM and the provider can never produce an adverse signal.
 * The real OCR/forensics pipeline (provider seam + pipeline.ts) feeds verification_documents; this wrapper
 * only reads the human decision off it.
 */

import {
  type ConsentRecord,
  type VerificationProvider,
  type VerificationResult,
  type VerificationSubscriberInput,
  VerificationOutcome,
  makeVerificationResult,
} from '../base'
import { documentReviewToOutcome, type DocumentReview } from '../document/logic'

const PROVIDER_KEY = 'document'
const METHOD_CLASS = 'document' as const

export interface DocumentProviderDeps {
  /** Latest document review for the subscriber, or null. Absent → dormant (UNABLE_TO_CONFIRM). */
  getLatestReview?: (subscriberId: string) => Promise<DocumentReview | null>
}

export function makeDocumentProvider(deps: DocumentProviderDeps = {}): VerificationProvider {
  return {
    providerKey: PROVIDER_KEY,
    methodClass: METHOD_CLASS,
    requiresConsent: false, // the subscriber uploads their own document under document-specific consent (Stage A)
    canAssertNotEnrolled: false, // a document can prove enrollment, never refute it (image-only, Part 8)
    async verify(input: VerificationSubscriberInput, _consent: ConsentRecord | null): Promise<VerificationResult> {
      if (!deps.getLatestReview) {
        // Dormant: no review source wired (document is disabled until the Part 9 gate opens).
        return makeVerificationResult(PROVIDER_KEY, METHOD_CLASS, VerificationOutcome.UNABLE_TO_CONFIRM, {
          errorMessage: 'document review dormant (LYCERT_DOC_REVIEW_ENABLED off / provider disabled)',
        })
      }
      const review = await deps.getLatestReview(input.subscriberId)
      const outcome = documentReviewToOutcome(review)
      // confidence defaults to 'medium' for the document method class (base.defaultConfidenceFor) — the hard cap.
      return makeVerificationResult(PROVIDER_KEY, METHOD_CLASS, outcome, {})
    },
  }
}
