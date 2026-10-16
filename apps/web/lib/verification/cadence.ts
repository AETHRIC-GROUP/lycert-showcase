/**
 * Re-verification cadence (LYCERT_VERIFICATION_ARCHITECTURE.md Part 9.3) — pure logic for the
 * lifecycle engine. A stored confirmation is only trusted until `verification_expires_at` (set by the
 * worker from the per-confidence REVERIFY_DAYS window); past it, the LIFECYCLE ENGINE (not the per-run
 * worker) transitions the subscriber to 'verification_expired' and re-enqueues verification.
 *
 * Legal invariants (Part 2.1): expiry is NEVER adverse — 'verification_expired' is an exact scoring
 * no-op (verification-signal.ts), identical to never having been verified. Both directions expire:
 * a stale verified_not_enrolled also lapses (the person may have re-enrolled since).
 */

export type ExpirableStatus = 'verified_enrolled' | 'verified_not_enrolled'

export interface VerificationCadenceRow {
  id: string
  verification_status: string | null
  verification_expires_at: string | null // ISO
}

/** True when the stored confirmation has lapsed and the lifecycle engine must expire + re-enqueue. */
export function isVerificationExpired(row: VerificationCadenceRow, now: Date): boolean {
  if (row.verification_status !== 'verified_enrolled' && row.verification_status !== 'verified_not_enrolled') {
    return false // unverified / already-expired / absent → nothing to lapse
  }
  if (!row.verification_expires_at) return false // no cadence recorded → never auto-expire
  const t = new Date(row.verification_expires_at).getTime()
  return Number.isFinite(t) && t <= now.getTime()
}

/**
 * The subscriber patch for a lapsed confirmation. Method/confidence/verified_at are kept for audit
 * ("what the last confirmation was"); only the status flips — and that status is a scoring no-op.
 */
export function verificationExpiryPatch(): { verification_status: 'verification_expired' } {
  return { verification_status: 'verification_expired' }
}
