/** Re-verification cadence (Part 9.3) — expiry is never adverse, both confirmations lapse. */
import { describe, expect, it } from 'vitest'
import { isVerificationExpired, verificationExpiryPatch } from './cadence'

const NOW = new Date('2026-07-07T12:00:00Z')
const row = (verification_status: string | null, verification_expires_at: string | null) => ({
  id: 's1', verification_status, verification_expires_at,
})

describe('isVerificationExpired', () => {
  it('lapses a verified_enrolled confirmation past its expiry', () => {
    expect(isVerificationExpired(row('verified_enrolled', '2026-07-01T00:00:00Z'), NOW)).toBe(true)
  })

  it('lapses a verified_not_enrolled too (the person may have re-enrolled since)', () => {
    expect(isVerificationExpired(row('verified_not_enrolled', '2026-07-01T00:00:00Z'), NOW)).toBe(true)
  })

  it('does not lapse a confirmation still inside its window', () => {
    expect(isVerificationExpired(row('verified_enrolled', '2026-08-01T00:00:00Z'), NOW)).toBe(false)
  })

  it('never touches unverified / already-expired / absent statuses', () => {
    expect(isVerificationExpired(row('unverified', '2026-07-01T00:00:00Z'), NOW)).toBe(false)
    expect(isVerificationExpired(row('verification_expired', '2026-07-01T00:00:00Z'), NOW)).toBe(false)
    expect(isVerificationExpired(row(null, '2026-07-01T00:00:00Z'), NOW)).toBe(false)
  })

  it('never auto-expires without a recorded cadence (missing/garbled expiry)', () => {
    expect(isVerificationExpired(row('verified_enrolled', null), NOW)).toBe(false)
    expect(isVerificationExpired(row('verified_enrolled', 'not-a-date'), NOW)).toBe(false)
  })
})

describe('verificationExpiryPatch', () => {
  it('flips ONLY the status — method/confidence/verified_at stay for audit', () => {
    expect(verificationExpiryPatch()).toEqual({ verification_status: 'verification_expired' })
  })
})
