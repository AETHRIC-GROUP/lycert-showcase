/**
 * Hosted re-verification flow primitives (Part 6.1): the signed link token + the consent text/fields.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { signLinkToken, verifyLinkToken } from './link-token'
import { consentFields, consentScreen, CONSENT_TEXT_VERSION } from './consent-text'

beforeAll(() => {
  // 64-char hex key (matches the LYCERT_ENCRYPTION_KEY contract used by lib/crypto.ts).
  process.env.LYCERT_ENCRYPTION_KEY = 'a'.repeat(64)
})

const NOW = new Date('2026-06-29T12:00:00Z')

describe('link token (sign/verify)', () => {
  it('round-trips a valid token and recovers the payload', () => {
    const t = signLinkToken('sub-1', 'ten-1', { now: NOW, ttlSeconds: 3600 })
    const v = verifyLinkToken(t, { now: new Date(NOW.getTime() + 60_000) })
    expect(v.valid).toBe(true)
    if (v.valid) {
      expect(v.payload.sub).toBe('sub-1')
      expect(v.payload.ten).toBe('ten-1')
    }
  })

  it('rejects an expired token', () => {
    const t = signLinkToken('sub-1', 'ten-1', { now: NOW, ttlSeconds: 60 })
    const v = verifyLinkToken(t, { now: new Date(NOW.getTime() + 120_000) })
    expect(v).toEqual({ valid: false, reason: 'expired' })
  })

  it('rejects a tampered payload (signature mismatch)', () => {
    const t = signLinkToken('sub-1', 'ten-1', { now: NOW, ttlSeconds: 3600 })
    const [, sig] = t.split('.')
    // Swap the payload for a different subscriber, keep the old signature.
    const forgedPayload = Buffer.from(JSON.stringify({ sub: 'attacker', ten: 'ten-1', exp: 9999999999 }), 'utf8')
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const v = verifyLinkToken(`${forgedPayload}.${sig}`, { now: NOW })
    expect(v).toEqual({ valid: false, reason: 'bad_signature' })
  })

  it('rejects malformed tokens', () => {
    expect(verifyLinkToken('', { now: NOW }).valid).toBe(false)
    expect(verifyLinkToken('onlyonepart', { now: NOW }).valid).toBe(false)
  })

  it('a token signed under a different key does not verify', () => {
    const t = signLinkToken('sub-1', 'ten-1', { now: NOW })
    process.env.LYCERT_ENCRYPTION_KEY = 'b'.repeat(64)
    const v = verifyLinkToken(t, { now: NOW })
    expect(v.valid).toBe(false)
    process.env.LYCERT_ENCRYPTION_KEY = 'a'.repeat(64) // restore for other tests
  })
})

describe('consent text (Part 6.1)', () => {
  it('exposes the five FERPA fields with the draft version', () => {
    const f = consentFields({ clientName: 'Acme Software' })
    expect(f.scope).toBe('enrollment_status')
    expect(f.purpose).toContain('Acme Software')
    expect(f.recipient).toMatch(/Clearinghouse/i)
    expect(f.consentTextVersion).toBe(CONSENT_TEXT_VERSION)
    expect(CONSENT_TEXT_VERSION).toMatch(/-draft$/) // gated until legal review
  })

  it('renders a consent screen with the client name and a draft notice', () => {
    const s = consentScreen({ clientName: 'Acme Software', supportEmail: 'help@acme.com' })
    expect(s.intro).toContain('Acme Software')
    expect(s.bullets.length).toBe(5)
    expect(s.draftNotice).toMatch(/legal review/i)
  })
})
