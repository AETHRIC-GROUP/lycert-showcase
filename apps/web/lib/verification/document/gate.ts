/**
 * Upload gate (LYCERT_DOCUMENT_REVIEW_ARCHITECTURE.md Part 9). The legally dangerous act is STORING a real
 * student document, so the UPLOAD is gated OFF by default — not just the OCR. A real document can only be
 * accepted when the env flag is on AND a document-specific consent row exists.
 */

/** Per-environment kill switch. Default OFF — staging included (Part 9 gate condition 1). */
export function docReviewEnabled(): boolean {
  return process.env.LYCERT_DOC_REVIEW_ENABLED === 'true'
}

export type UploadGate = { allowed: true } | { allowed: false; reason: 'disabled' | 'no_consent' }

/**
 * Pure gate decision (testable without env/DB): upload is allowed only when the flag is on AND a
 * document-specific consent is present. Either missing → deny, store nothing.
 */
export function checkUploadAllowed(enabled: boolean, hasDocumentConsent: boolean): UploadGate {
  if (!enabled) return { allowed: false, reason: 'disabled' }
  if (!hasDocumentConsent) return { allowed: false, reason: 'no_consent' }
  return { allowed: true }
}
