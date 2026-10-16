/**
 * Stateless signed token for the hosted re-verification flow (Part 6.1) — identifies which subscriber
 * (and tenant) a verification link belongs to, without a DB round-trip or a new table.
 *
 * Format: base64url(payloadJson) + '.' + base64url(HMAC-SHA256(payloadJson)). The signing key is derived
 * from the existing LYCERT_ENCRYPTION_KEY (no new secret to provision) via HMAC(key, 'verification-link-v1'),
 * so a leaked link can't be forged and can't double as the credential-encryption key. Tokens carry an
 * expiry; verification is timing-safe.
 *
 * This only proves "this link was issued by us for subscriber X" — it does NOT grant consent or run any
 * provider. Consent is a separate, explicit action the subscriber takes on the page (Part 6.1).
 */
import crypto from 'crypto'

const PURPOSE = 'verification-link-v1'

export interface LinkPayload {
  sub: string // subscriber id
  ten: string // tenant id
  exp: number // unix seconds
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function unb64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

/** Signing subkey derived from the credential-encryption key (separation of use). Throws if unset. */
function signingKey(): Buffer {
  const hex = process.env.LYCERT_ENCRYPTION_KEY ?? ''
  if (hex.length !== 64) throw new Error('LYCERT_ENCRYPTION_KEY must be a 64-char hex string')
  return crypto.createHmac('sha256', Buffer.from(hex, 'hex')).update(PURPOSE).digest()
}

function sign(payloadB64: string, key: Buffer): string {
  return b64url(crypto.createHmac('sha256', key).update(payloadB64).digest())
}

/** Mint a signed link token for a subscriber. ttlSeconds default 14 days (re-verification window). */
export function signLinkToken(sub: string, ten: string, opts: { now?: Date; ttlSeconds?: number } = {}): string {
  const now = opts.now ?? new Date()
  const exp = Math.floor(now.getTime() / 1000) + (opts.ttlSeconds ?? 14 * 24 * 60 * 60)
  const payload: LinkPayload = { sub, ten, exp }
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), 'utf8'))
  return `${payloadB64}.${sign(payloadB64, signingKey())}`
}

export type VerifyResult = { valid: true; payload: LinkPayload } | { valid: false; reason: 'malformed' | 'bad_signature' | 'expired' }

/** Verify a link token: signature (timing-safe) then expiry. Never throws on bad input. */
export function verifyLinkToken(token: string, opts: { now?: Date } = {}): VerifyResult {
  const parts = (token ?? '').split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { valid: false, reason: 'malformed' }
  let key: Buffer
  try { key = signingKey() } catch { return { valid: false, reason: 'malformed' } }
  const expected = sign(parts[0], key)
  const a = Buffer.from(expected)
  const b = Buffer.from(parts[1])
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { valid: false, reason: 'bad_signature' }
  let payload: LinkPayload
  try {
    payload = JSON.parse(unb64url(parts[0]).toString('utf8'))
  } catch {
    return { valid: false, reason: 'malformed' }
  }
  if (!payload?.sub || !payload?.ten || typeof payload.exp !== 'number') return { valid: false, reason: 'malformed' }
  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000)
  if (payload.exp <= now) return { valid: false, reason: 'expired' }
  return { valid: true, payload }
}
