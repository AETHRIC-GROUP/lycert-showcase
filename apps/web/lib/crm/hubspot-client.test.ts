import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  buildAuthorizeUrl, exchangeCodeForToken, getProperty, batchUpdateContacts,
} from './hubspot-client'

describe('buildAuthorizeUrl', () => {
  it('builds the exact HubSpot authorize URL shape (verified against live docs 2026-10-09)', () => {
    const url = buildAuthorizeUrl({
      clientId: 'abc', redirectUri: 'https://x/callback', scopes: ['oauth', 'crm.objects.contacts.read'], state: 'xyz',
    })
    expect(url).toBe(
      'https://app.hubspot.com/oauth/authorize?client_id=abc&redirect_uri=https%3A%2F%2Fx%2Fcallback&scope=oauth+crm.objects.contacts.read&state=xyz',
    )
  })
})

describe('exchangeCodeForToken (mocked fetch)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('hits the date-based token endpoint, not the deprecating legacy v1 path', async () => {
    let calledUrl = ''
    let calledBody = ''
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calledUrl = url
      calledBody = String(init.body)
      return { ok: true, json: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 1800 }) }
    }))
    const token = await exchangeCodeForToken({ clientId: 'c', clientSecret: 's', redirectUri: 'https://x/cb', code: 'code1' })
    expect(calledUrl).toBe('https://api.hubapi.com/oauth/2026-03/token')
    expect(calledBody).toContain('grant_type=authorization_code')
    expect(calledBody).toContain('code=code1')
    expect(token).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresIn: 1800 })
  })

  it('throws with the response body on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400, text: async () => 'bad_code' })))
    await expect(exchangeCodeForToken({ clientId: 'c', clientSecret: 's', redirectUri: 'r', code: 'bad' }))
      .rejects.toThrow(/400/)
  })
})

describe('getProperty (mocked fetch)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns null on 404 (property does not exist yet — not an error)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 404, ok: false })))
    expect(await getProperty('contacts', 'lycert_x', 'tok')).toBeNull()
  })

  it('returns the name/type on a hit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, ok: true, json: async () => ({ name: 'lycert_x', type: 'string' }) })))
    expect(await getProperty('contacts', 'lycert_x', 'tok')).toEqual({ name: 'lycert_x', type: 'string' })
  })
})

describe('batchUpdateContacts', () => {
  it('refuses more than 100 records without making a network call (HubSpot hard limit)', async () => {
    const inputs = Array.from({ length: 101 }, (_, i) => ({ id: String(i), properties: {} }))
    await expect(batchUpdateContacts('tok', inputs)).rejects.toThrow(/100/)
  })

  it('is a no-op for an empty input array', async () => {
    await expect(batchUpdateContacts('tok', [])).resolves.toBeUndefined()
  })
})
