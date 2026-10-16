/** ZeroBounce decision table, FullEnrich webhook-token URL, and a mocked-fetch client path. */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { interpret } from './zerobounce'
import { withWebhookToken } from './fullenrich'
import { HunterClient, DatagmaClient } from './clients'
import { ProviderOutcome } from './base'

describe('ZeroBounce interpret (Part 1.1 decision table)', () => {
  it('blocks ONLY disposable; invalid is recorded but proceeds (policy 2026-06-21)', () => {
    expect(interpret({ status: 'valid', free_email: true }).blocksEnrichment).toBe(false)
    expect(interpret({ status: 'catch-all' }).status).toBe('catch_all')
    // invalid no longer blocks (enrichment feeds scoring, not delivery) — but status is still recorded.
    const inv = interpret({ status: 'invalid' })
    expect(inv.blocksEnrichment).toBe(false)
    expect(inv.status).toBe('invalid')
    const disp = interpret({ status: 'do_not_mail', sub_status: 'disposable' })
    expect(disp.blocksEnrichment).toBe(true)
    expect(disp.emailDomainTypeOverride).toBe('disposable')
    expect(interpret({ status: 'spamtrap' }).blocksEnrichment).toBe(false) // unlisted → proceed
  })
})

describe('FullEnrich withWebhookToken', () => {
  it('appends the shared-secret token, handling existing query strings', () => {
    expect(withWebhookToken('https://x/api/webhook/fullenrich', 'sek', undefined)).toBe('https://x/api/webhook/fullenrich?token=sek')
    expect(withWebhookToken('https://x/api/webhook/fullenrich?a=1', 'sek', undefined)).toBe('https://x/api/webhook/fullenrich?a=1&token=sek')
    expect(withWebhookToken('https://x/api/webhook/fullenrich', undefined, undefined)).toBe('https://x/api/webhook/fullenrich') // no token → unchanged
    expect(withWebhookToken('', 'sek', undefined)).toBe('')
  })
  it('also appends the Vercel protection-bypass param when present', () => {
    expect(withWebhookToken('https://x/api/webhook/fullenrich', 'sek', 'byp'))
      .toBe('https://x/api/webhook/fullenrich?token=sek&x-vercel-protection-bypass=byp')
  })
})

describe('HunterClient.enrich (mocked fetch)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('200 hit → PARTIAL with fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ data: { employment: { name: 'Gensler', title: 'Architect' }, linkedin: { handle: 'in/x' }, name: { fullName: 'Jane Smith' } } }),
    })))
    const r = await new HunterClient('k').enrich('a@b.com', null, 's1')
    expect(r.outcome).toBe(ProviderOutcome.PARTIAL)
    expect(r.fields.li_current_employer_name).toBe('Gensler')
    expect(r.charged).toBe(true)
  })

  it('404 → MISS', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })))
    expect((await new HunterClient('k').enrich('a@b.com', null, 's1')).outcome).toBe(ProviderOutcome.MISS)
  })

  it('no key → MISS (no call)', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    expect((await new HunterClient('').enrich('a@b.com', null, 's1')).outcome).toBe(ProviderOutcome.MISS)
    expect(f).not.toHaveBeenCalled()
  })
})

describe('DatagmaClient.enrich (mocked fetch)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('uses data= + personFull=true (NOT email=) — request-format regression', async () => {
    let url = ''
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { url = String(u); return { ok: true, status: 200, json: async () => ({ person: null }) } }))
    await new DatagmaClient('k').enrich('a@gmail.com', null, 's1')
    expect(url).toContain('data=a%40gmail.com')
    expect(url).toContain('personFull=true')
    expect(url).not.toMatch(/[?&]email=/) // the old param that 400s
  })

  it('400 "This email is not accepted" → MISS, not ERROR (Datagma declines free/edu domains)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ code: 3, message: 'This email is not accepted' }) })))
    expect((await new DatagmaClient('k').enrich('a@gmail.com', null, 's1')).outcome).toBe(ProviderOutcome.MISS)
  })
})
