import { describe, it, expect } from 'vitest'
import crypto from 'crypto'
import { verifyWebhookSignature } from './webhook-signature'

const SECRET = 'test-client-secret'

function sign(method: string, url: string, rawBody: string, timestamp: string): string {
  return crypto.createHmac('sha256', SECRET).update(`${method.toUpperCase()}${url}${rawBody}${timestamp}`).digest('base64')
}

describe('verifyWebhookSignature', () => {
  it('accepts a correctly-signed request within the replay window', () => {
    const now = new Date('2026-10-12T00:00:00Z')
    const timestamp = String(now.getTime())
    const url = 'https://x.lycert.com/api/crm/hubspot/webhook'
    const rawBody = '[{"objectId":1}]'
    const signatureHeader = sign('POST', url, rawBody, timestamp)
    const result = verifyWebhookSignature({
      method: 'POST', url, rawBody, signatureHeader, timestampHeader: timestamp, clientSecret: SECRET, now,
    })
    expect(result).toEqual({ valid: true })
  })

  it('rejects a tampered body (signature no longer matches)', () => {
    const now = new Date('2026-10-12T00:00:00Z')
    const timestamp = String(now.getTime())
    const url = 'https://x.lycert.com/api/crm/hubspot/webhook'
    const signatureHeader = sign('POST', url, '[{"objectId":1}]', timestamp)
    const result = verifyWebhookSignature({
      method: 'POST', url, rawBody: '[{"objectId":2}]', signatureHeader, timestampHeader: timestamp, clientSecret: SECRET, now,
    })
    expect(result).toEqual({ valid: false, reason: 'bad_signature' })
  })

  it('rejects a timestamp older than 5 minutes (replay protection)', () => {
    const now = new Date('2026-10-12T00:10:00Z') // 10 min after the signed timestamp
    const signedAt = new Date('2026-10-12T00:00:00Z')
    const timestamp = String(signedAt.getTime())
    const url = 'https://x.lycert.com/api/crm/hubspot/webhook'
    const rawBody = '[]'
    const signatureHeader = sign('POST', url, rawBody, timestamp)
    const result = verifyWebhookSignature({
      method: 'POST', url, rawBody, signatureHeader, timestampHeader: timestamp, clientSecret: SECRET, now,
    })
    expect(result).toEqual({ valid: false, reason: 'stale_timestamp' })
  })

  it('rejects missing headers without throwing', () => {
    expect(verifyWebhookSignature({
      method: 'POST', url: 'https://x', rawBody: '[]', signatureHeader: null, timestampHeader: '123', clientSecret: SECRET,
    })).toEqual({ valid: false, reason: 'missing_headers' })
    expect(verifyWebhookSignature({
      method: 'POST', url: 'https://x', rawBody: '[]', signatureHeader: 'abc', timestampHeader: null, clientSecret: SECRET,
    })).toEqual({ valid: false, reason: 'missing_headers' })
  })

  it('is method- and URL-sensitive (changing either breaks the signature)', () => {
    const now = new Date('2026-10-12T00:00:00Z')
    const timestamp = String(now.getTime())
    const url = 'https://x.lycert.com/api/crm/hubspot/webhook'
    const rawBody = '[]'
    const signatureHeader = sign('POST', url, rawBody, timestamp)
    const wrongMethod = verifyWebhookSignature({
      method: 'GET', url, rawBody, signatureHeader, timestampHeader: timestamp, clientSecret: SECRET, now,
    })
    expect(wrongMethod.valid).toBe(false)
    const wrongUrl = verifyWebhookSignature({
      method: 'POST', url: url + '/extra', rawBody, signatureHeader, timestampHeader: timestamp, clientSecret: SECRET, now,
    })
    expect(wrongUrl.valid).toBe(false)
  })
})
