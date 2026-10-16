/** ensureValidation (Stage-0 gate) IO logic — cache freshness, ZeroBounce call + persist, no-key/
 * outage skip, disposable override — against a fake Supabase client and stubbed fetch (no network). */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { makeEnrichmentIO } from './worker-io'
import type { SubscriberForEnrichment } from './worker'

type Captured = { patch?: Record<string, unknown>; updates: number }

function fakeDb(captured: Captured) {
  return {
    from() {
      return {
        update(patch: Record<string, unknown>) {
          captured.patch = patch
          captured.updates++
          return { eq: async () => ({ error: null }) }
        },
      }
    },
  } as never
}

const sub = (over: Partial<SubscriberForEnrichment> = {}): SubscriberForEnrichment => ({
  id: 's1', email: 'a@b.com', name: 'Jane', emailValidationStatus: null, emailValidatedAt: null, enrichmentPriority: 50, ...over,
})

const zbResponse = (body: Record<string, unknown>) =>
  vi.fn(async () => ({ ok: true, status: 200, json: async () => body }))

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.LYCERT_ZEROBOUNCE_API_KEY
  delete process.env.LYCERT_FULLENRICH_API_KEY
  delete process.env.LYCERT_FULLENRICH_WEBHOOK_URL
})

describe('checkAsyncHealth (FullEnrich preflight — credit guard)', () => {
  const noDb = { from() { throw new Error('db not used') } } as never

  it('placeholder webhook URL → false WITHOUT pinging (regression guard for the 2026-06-21 incident)', async () => {
    process.env.LYCERT_FULLENRICH_API_KEY = 'k'
    process.env.LYCERT_FULLENRICH_WEBHOOK_URL = 'https://<staging>/api/enrichment/webhook/fullenrich'
    const f = vi.fn(); vi.stubGlobal('fetch', f)
    expect(await makeEnrichmentIO(noDb).checkAsyncHealth()).toBe(false)
    expect(f).not.toHaveBeenCalled() // never even ping a placeholder host
  })

  it('no FullEnrich key → false (nothing to submit), no ping', async () => {
    process.env.LYCERT_FULLENRICH_WEBHOOK_URL = 'https://real.example.com/api/enrichment/webhook/fullenrich'
    const f = vi.fn(); vi.stubGlobal('fetch', f)
    expect(await makeEnrichmentIO(noDb).checkAsyncHealth()).toBe(false)
    expect(f).not.toHaveBeenCalled()
  })

  it('non-https URL → false, no ping', async () => {
    process.env.LYCERT_FULLENRICH_API_KEY = 'k'
    process.env.LYCERT_FULLENRICH_WEBHOOK_URL = 'http://real.example.com/x'
    const f = vi.fn(); vi.stubGlobal('fetch', f)
    expect(await makeEnrichmentIO(noDb).checkAsyncHealth()).toBe(false)
    expect(f).not.toHaveBeenCalled()
  })

  it('valid URL + receiver 200 → true (and caches: pings once)', async () => {
    process.env.LYCERT_FULLENRICH_API_KEY = 'k'
    process.env.LYCERT_FULLENRICH_WEBHOOK_URL = 'https://real.example.com/api/enrichment/webhook/fullenrich'
    const f = vi.fn(async () => ({ ok: true, status: 200 })); vi.stubGlobal('fetch', f)
    const io = makeEnrichmentIO(noDb)
    expect(await io.checkAsyncHealth()).toBe(true)
    expect(await io.checkAsyncHealth()).toBe(true) // cached
    expect(f).toHaveBeenCalledOnce()
  })

  it('valid URL + receiver non-200 → false (deploy down / token mismatch)', async () => {
    process.env.LYCERT_FULLENRICH_API_KEY = 'k'
    process.env.LYCERT_FULLENRICH_WEBHOOK_URL = 'https://real.example.com/api/enrichment/webhook/fullenrich'
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401 })))
    expect(await makeEnrichmentIO(noDb).checkAsyncHealth()).toBe(false)
  })
})

describe('ensureValidation (live Stage-0 gate)', () => {
  it('fresh cache → no ZeroBounce call, blocks only on a blocking status', async () => {
    const f = vi.fn(); vi.stubGlobal('fetch', f)
    const cap: Captured = { updates: 0 }
    const io = makeEnrichmentIO(fakeDb(cap))
    const fresh = new Date().toISOString()
    expect(await io.ensureValidation(sub({ emailValidationStatus: 'valid', emailValidatedAt: fresh }))).toBe(false)
    expect(await io.ensureValidation(sub({ emailValidationStatus: 'disposable', emailValidatedAt: fresh }))).toBe(true)
    expect(f).not.toHaveBeenCalled()
    expect(cap.updates).toBe(0) // cached → never re-persisted
  })

  it('stale cache → re-validates (calls ZeroBounce)', async () => {
    process.env.LYCERT_ZEROBOUNCE_API_KEY = 'k'
    const f = zbResponse({ status: 'valid' }); vi.stubGlobal('fetch', f)
    const cap: Captured = { updates: 0 }
    const io = makeEnrichmentIO(fakeDb(cap))
    const old = new Date(Date.now() - 200 * 24 * 3600 * 1000).toISOString() // >180d
    expect(await io.ensureValidation(sub({ emailValidationStatus: 'valid', emailValidatedAt: old }))).toBe(false)
    expect(f).toHaveBeenCalledOnce()
    expect(cap.updates).toBe(1)
  })

  it('no cache + valid → calls, persists status, does not block', async () => {
    process.env.LYCERT_ZEROBOUNCE_API_KEY = 'k'
    vi.stubGlobal('fetch', zbResponse({ status: 'valid', did_you_mean: null }))
    const cap: Captured = { updates: 0 }
    const io = makeEnrichmentIO(fakeDb(cap))
    expect(await io.ensureValidation(sub())).toBe(false)
    expect(cap.patch?.email_validation_status).toBe('valid')
    expect(cap.patch?.email_validated_at).toBeTruthy()
  })

  it('disposable → blocks AND writes email_domain_type override', async () => {
    process.env.LYCERT_ZEROBOUNCE_API_KEY = 'k'
    vi.stubGlobal('fetch', zbResponse({ status: 'do_not_mail', sub_status: 'disposable' }))
    const cap: Captured = { updates: 0 }
    const io = makeEnrichmentIO(fakeDb(cap))
    expect(await io.ensureValidation(sub())).toBe(true)
    expect(cap.patch?.email_validation_status).toBe('disposable')
    expect(cap.patch?.email_domain_type).toBe('disposable')
  })

  it('invalid → recorded but NOT blocked (disposable-only policy)', async () => {
    process.env.LYCERT_ZEROBOUNCE_API_KEY = 'k'
    vi.stubGlobal('fetch', zbResponse({ status: 'invalid', sub_status: 'mailbox_not_found' }))
    const cap: Captured = { updates: 0 }
    const io = makeEnrichmentIO(fakeDb(cap))
    expect(await io.ensureValidation(sub())).toBe(false)
    expect(cap.patch?.email_validation_status).toBe('invalid')
  })

  it('no API key → no call, no persist, never blocks', async () => {
    const f = vi.fn(); vi.stubGlobal('fetch', f)
    const cap: Captured = { updates: 0 }
    const io = makeEnrichmentIO(fakeDb(cap))
    expect(await io.ensureValidation(sub())).toBe(false)
    expect(f).not.toHaveBeenCalled() // ZeroBounceClient short-circuits with no key
    expect(cap.updates).toBe(0)
  })
})
