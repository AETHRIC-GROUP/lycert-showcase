/**
 * Consent enforcement — LYCERT_VERIFICATION_ARCHITECTURE.md Part 6.1.
 *
 * FERPA/GDPR: no `requires_consent=true` provider (NSC/HEDD/SSO/DigiLocker) may run without an ACTIVE,
 * unexpired, unrevoked consent row. This is enforced HERE, in code — not only in the UI (Part 6.1, Part 10).
 * No consent → the provider is SKIPPED, never FAILED (Part 3.1): "no consent → NSC step is skipped, not
 * failed." A skip is neutral; it never becomes an adverse signal.
 */

import type { ConsentRecord, VerificationProvider } from './base'

/** A consent is active iff it exists, is not revoked, and is not past its expiry. */
export function isConsentActive(consent: ConsentRecord | null, now: Date): boolean {
  if (!consent) return false
  if (consent.revokedAt) return false
  if (consent.expiresAt && new Date(consent.expiresAt).getTime() <= now.getTime()) return false
  return true
}

export type ConsentGate =
  | { allowed: true }
  | { allowed: false; reason: 'no_consent' | 'revoked' | 'expired' }

/**
 * Decide whether a provider may run for the given consent state.
 * - Provider does not require consent → always allowed (email_loop, document).
 * - Provider requires consent → allowed only when a consent row is active; otherwise SKIP with a reason.
 */
export function checkConsentGate(
  provider: Pick<VerificationProvider, 'requiresConsent'>,
  consent: ConsentRecord | null,
  now: Date,
): ConsentGate {
  if (!provider.requiresConsent) return { allowed: true }
  if (!consent) return { allowed: false, reason: 'no_consent' }
  if (consent.revokedAt) return { allowed: false, reason: 'revoked' }
  if (consent.expiresAt && new Date(consent.expiresAt).getTime() <= now.getTime()) {
    return { allowed: false, reason: 'expired' }
  }
  return { allowed: true }
}
