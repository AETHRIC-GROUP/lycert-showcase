/**
 * Stateless signed `state` param for the HubSpot OAuth install flow (Bridge Part 6.3 step 2) — proves
 * the callback belongs to the install this tenant's admin started, without a server-side session table.
 * Same construction as lib/verification/link-token.ts (HMAC derived from LYCERT_ENCRYPTION_KEY, distinct
 * purpose string so the subkey can't double as another token's signing key). 10-minute expiry per spec.
 */
import crypto from 'crypto'

const PURPOSE = 'hubspot-oauth-state-v1'

export interface OAuthStatePayload {
  ten: string // tenant id
  nonce: string
  exp: number // unix seconds
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function unb64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

function signingKey(): Buffer {
  const hex = process.env.LYCERT_ENCRYPTION_KEY ?? ''
  if (hex.length !== 64) throw new Error('LYCERT_ENCRYPTION_KEY must be a 64-char hex string')
  return crypto.createHmac('sha256', Buffer.from(hex, 'hex')).update(PURPOSE).digest()
}

function sign(payloadB64: string, key: Buffer): string {
  return b64url(crypto.createHmac('sha256', key).update(payloadB64).digest())
}

/** Mint a signed state token. Default TTL 10 minutes (Bridge 6.3 step 2). */
export function signOAuthState(tenantId: string, opts: { now?: Date; ttlSeconds?: number } = {}): string {
  const now = opts.now ?? new Date()
  const exp = Math.floor(now.getTime() / 1000) + (opts.ttlSeconds ?? 10 * 60)
  const payload: OAuthStatePayload = { ten: tenantId, nonce: crypto.randomBytes(9).toString('hex'), exp }
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), 'utf8'))
  return `${payloadB64}.${sign(payloadB64, signingKey())}`
}

export type VerifyStateResult =
  | { valid: true; payload: OAuthStatePayload }
  | { valid: false; reason: 'malformed' | 'bad_signature' | 'expired' }

export function verifyOAuthState(token: string, opts: { now?: Date } = {}): VerifyStateResult {
  const parts = (token ?? '').split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { valid: false, reason: 'malformed' }
  let key: Buffer
  try { key = signingKey() } catch { return { valid: false, reason: 'malformed' } }
  const expected = sign(parts[0], key)
  const a = Buffer.from(expected)
  const b = Buffer.from(parts[1])
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { valid: false, reason: 'bad_signature' }
  let payload: OAuthStatePayload
  try {
    payload = JSON.parse(unb64url(parts[0]).toString('utf8'))
  } catch {
    return { valid: false, reason: 'malformed' }
  }
  if (!payload?.ten || !payload?.nonce || typeof payload.exp !== 'number') return { valid: false, reason: 'malformed' }
  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000)
  if (payload.exp <= now) return { valid: false, reason: 'expired' }
  return { valid: true, payload }
}
