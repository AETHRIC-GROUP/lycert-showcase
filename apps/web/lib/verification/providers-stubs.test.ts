/**
 * Gated-provider stubs (Part 4 / Part 9.2 step 7 / Part 10): HEDD + document. Each must be SAFE if
 * mis-enabled — never confirming or refuting enrollment — and the factory must expose only the
 * implemented providers (sso has no class yet).
 */
import { describe, it, expect } from 'vitest'
import { VerificationOutcome } from './base'
import { makeHeddProvider } from './providers/hedd'
import { makeDocumentProvider } from './providers/document'
import { makeVerificationProvider } from './providers'

const input = {
  subscriberId: 's', tenantId: 't', email: 'jane@uni.ac.uk', name: 'Jane',
  institutionName: 'Uni', institutionCountry: 'GB', statedGraduationDate: null,
}

describe('HEDD stub (Part 4)', () => {
  it('is authoritative + consent-gated but never confirms/refutes while stubbed', async () => {
    const hedd = makeHeddProvider()
    expect(hedd.methodClass).toBe('authoritative')
    expect(hedd.requiresConsent).toBe(true)
    expect(hedd.canAssertNotEnrolled).toBe(true)
    const r = await hedd.verify(input, null)
    expect(r.outcome).toBe(VerificationOutcome.UNABLE_TO_CONFIRM)
    expect(r.errorMessage).toMatch(/pending/)
  })
})

describe('document stub (Part 9.2 step 7)', () => {
  it('falls through (no OCR pipeline yet), never adverse, no consent required', async () => {
    const doc = makeDocumentProvider()
    expect(doc.methodClass).toBe('document')
    expect(doc.requiresConsent).toBe(false)
    expect(doc.canAssertNotEnrolled).toBe(false)
    const r = await doc.verify(input, null)
    expect(r.outcome).toBe(VerificationOutcome.UNABLE_TO_CONFIRM)
  })
})

describe('makeVerificationProvider factory', () => {
  const deps = { now: () => new Date(), getCompletedChallenge: async () => null }
  it('builds the implemented providers and returns null for sso / unknown', () => {
    for (const k of ['email_loop', 'nsc', 'hedd', 'document']) {
      expect(makeVerificationProvider(k, deps)).not.toBeNull()
    }
    expect(makeVerificationProvider('sso', deps)).toBeNull()
    expect(makeVerificationProvider('digilocker', deps)).toBeNull() // no class yet
    expect(makeVerificationProvider('bogus', deps)).toBeNull()
  })
})
