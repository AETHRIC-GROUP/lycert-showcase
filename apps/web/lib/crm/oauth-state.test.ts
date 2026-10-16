import { describe, it, expect, beforeEach } from 'vitest'
import { signOAuthState, verifyOAuthState } from './oauth-state'

beforeEach(() => {
  process.env.LYCERT_ENCRYPTION_KEY = 'a'.repeat(64)
})

describe('OAuth state token', () => {
  it('round-trips: sign then verify succeeds and carries the tenant id', () => {
    const token = signOAuthState('tenant-1', { now: new Date('2026-10-09T00:00:00Z') })
    const result = verifyOAuthState(token, { now: new Date('2026-10-09T00:05:00Z') })
    expect(result.valid).toBe(true)
    if (result.valid) expect(result.payload.ten).toBe('tenant-1')
  })

  it('rejects an expired token (past the 10-minute default TTL)', () => {
    const token = signOAuthState('tenant-1', { now: new Date('2026-10-09T00:00:00Z') })
    const result = verifyOAuthState(token, { now: new Date('2026-10-09T00:11:00Z') })
    expect(result).toEqual({ valid: false, reason: 'expired' })
  })

  it('rejects a tampered payload', () => {
    const token = signOAuthState('tenant-1')
    const [payload, sig] = token.split('.')
    const tampered = `${payload}x.${sig}`
    expect(verifyOAuthState(tampered).valid).toBe(false)
  })

  it('rejects malformed tokens without throwing', () => {
    expect(verifyOAuthState('').valid).toBe(false)
    expect(verifyOAuthState('not-a-token').valid).toBe(false)
    expect(verifyOAuthState('a.b.c').valid).toBe(false)
  })

  it('two states for the same tenant are never identical (nonce)', () => {
    expect(signOAuthState('tenant-1')).not.toBe(signOAuthState('tenant-1'))
  })
})
