/**
 * HubSpot v3 webhook signature validation (Bridge Part 11 — "signature validation on every inbound
 * webhook"). Scheme verified against live HubSpot docs 2026-10-12 (DECISIONS.md) — not invented:
 * HMAC-SHA256(clientSecret, UPPERCASE_METHOD + full_absolute_url + raw_body + timestamp), base64,
 * constant-time compare. v3 is the only signature version with replay protection — reject anything
 * older than 5 minutes.
 */
import crypto from 'crypto'

const MAX_AGE_MS = 5 * 60 * 1000

export interface VerifyWebhookInput {
  method: string
  url: string // full absolute URL, as HubSpot would have seen it
  rawBody: string
  signatureHeader: string | null
  timestampHeader: string | null
  clientSecret: string
  now?: Date
}

export type VerifyWebhookResult =
  | { valid: true }
  | { valid: false; reason: 'missing_headers' | 'stale_timestamp' | 'bad_signature' }

export function verifyWebhookSignature(input: VerifyWebhookInput): VerifyWebhookResult {
  if (!input.signatureHeader || !input.timestampHeader) return { valid: false, reason: 'missing_headers' }

  const timestamp = Number(input.timestampHeader)
  const now = (input.now ?? new Date()).getTime()
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > MAX_AGE_MS) {
    return { valid: false, reason: 'stale_timestamp' }
  }

  const base = `${input.method.toUpperCase()}${input.url}${input.rawBody}${input.timestampHeader}`
  const expected = crypto.createHmac('sha256', input.clientSecret).update(base).digest('base64')

  const a = Buffer.from(expected)
  const b = Buffer.from(input.signatureHeader)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { valid: false, reason: 'bad_signature' }
  return { valid: true }
}
