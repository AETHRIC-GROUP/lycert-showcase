/** V3 providers (LYCERT_WATERFALL_ENRICHMENT_V3.md Part 1): mappers (pure) + clients (mocked fetch).
 * Findymail (sync), Icypeas + Dropcontact (async submit→PENDING + poll status machine). */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mapDropcontactRecord, mapFindymailPerson, mapIcypeasResults } from './mappers'
import { FindymailClient } from './clients'
import { IcypeasClient } from './icypeas'
import { DropcontactClient } from './dropcontact'
import { classifyCompleteness, ProviderOutcome } from './base'

const resp = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) })

// ── Mappers ─────────────────────────────────────────────────────────────────
describe('V3 mappers', () => {
  it('findymail core fields → PARTIAL (no edu/dates)', () => {
    const f = mapFindymailPerson({ fullName: 'Jane', headline: 'CEO at X', jobTitle: 'CEO', companyName: 'ExampleInc' })
    expect(f.li_job_title).toBe('CEO')
    expect(f.li_current_employer_name).toBe('ExampleInc')
    expect(classifyCompleteness(f)).toBe(ProviderOutcome.PARTIAL)
  })

  it('findymail headline fallback + defensive linkedin key', () => {
    const f = mapFindymailPerson({ headline: 'Architect', companyName: 'Gensler', linkedin_url: 'https://linkedin.com/in/j' })
    expect(f.li_job_title).toBe('Architect')
    expect(f.linkedin_profile_url).toBe('https://linkedin.com/in/j')
  })

  it('findymail empty → MISS', () => {
    expect(classifyCompleteness(mapFindymailPerson({}))).toBe(ProviderOutcome.MISS)
  })

  it('dropcontact verified fields → PARTIAL', () => {
    const f = mapDropcontactRecord({ job: 'Engineer', company: 'Acme', website: 'acme.com', linkedin: 'https://li/in/x' })
    expect(f).toEqual({
      linkedin_profile_url: 'https://li/in/x',
      li_job_title: 'Engineer',
      li_current_employer_name: 'Acme',
      li_current_employer_domain: 'acme.com',
    })
    expect(classifyCompleteness(f)).toBe(ProviderOutcome.PARTIAL)
  })

  it('icypeas flat profile; GDPR — emails/phones never mapped', () => {
    const f = mapIcypeasResults({ jobTitle: 'Designer', company: 'StudioX', linkedin: 'https://li/in/z', emails: ['x@y.com'], phones: ['+1'] })
    expect(f.li_job_title).toBe('Designer')
    expect(f.linkedin_profile_url).toBe('https://li/in/z')
    expect(JSON.stringify(f)).not.toContain('@')
  })

  it('icypeas linkedin-style with dates + education → COMPLETE (ISO dates)', () => {
    const f = mapIcypeasResults({
      linkedin: 'https://li/in/full',
      positionHistory: [{ title: 'Senior Engineer', companyName: 'BigCo', startEndDate: { start: { month: 3, year: 2021 }, end: null } }],
      educationHistory: [{ schoolName: 'MIT', startEndDate: { start: { year: 2014 }, end: { year: 2018 } } }],
    })
    expect(f.li_job_start_date).toBe('2021-03-01')
    expect(f.li_education_end_date).toBe('2018-12-31')
    expect(classifyCompleteness(f)).toBe(ProviderOutcome.COMPLETE)
  })
})

// ── Findymail client (sync) ───────────────────────────────────────────────────
describe('FindymailClient', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('200 hit → PARTIAL; sends {email, with_profile:true}', async () => {
    const f = vi.fn(async (_u: string, _i: any) => resp(200, { fullName: 'Jane', jobTitle: 'CEO', companyName: 'ExampleInc', linkedin_url: 'https://li/in/j' }))
    vi.stubGlobal('fetch', f)
    const r = await new FindymailClient('k').enrich('a@b.com', 'Jane Doe', 's1')
    expect(r.outcome).toBe(ProviderOutcome.PARTIAL)
    expect(r.fields.li_current_employer_name).toBe('ExampleInc')
    expect(r.charged).toBe(true)
    expect(JSON.parse(f.mock.calls[0]![1].body)).toEqual({ email: 'a@b.com', with_profile: true })
  })

  it('404 → MISS', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resp(404, {})))
    expect((await new FindymailClient('k').enrich('a@b.com', null, 's1')).outcome).toBe(ProviderOutcome.MISS)
  })

  it('no key → MISS (no call)', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    expect((await new FindymailClient('').enrich('a@b.com', null, 's1')).outcome).toBe(ProviderOutcome.MISS)
    expect(f).not.toHaveBeenCalled()
  })
})

// ── Icypeas client (async, poll) ────────────────────────────────────────────────
describe('IcypeasClient', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('submit → PENDING + ref; body carries userData.externalId', async () => {
    const f = vi.fn(async (_u: string, _i: any) => resp(200, { success: true, item: { status: 'NONE', _id: 'p_123' } }))
    vi.stubGlobal('fetch', f)
    const r = await new IcypeasClient('k').enrich('a@b.com', null, 'sub-9')
    expect(r.outcome).toBe(ProviderOutcome.PENDING)
    expect(r.asyncReference).toBe('p_123')
    expect(JSON.parse(f.mock.calls[0]![1].body)).toEqual({ email: 'a@b.com', userData: { externalId: 'sub-9' } })
  })

  it('submit answers inline with terminal NOT_FOUND → MISS, no poll, free', async () => {
    const f = vi.fn(async (_u: string, _i: any) => resp(200, { success: true, result: '', searchId: 'x1', status: 'NOT_FOUND' }))
    vi.stubGlobal('fetch', f)
    const r = await new IcypeasClient('k').enrich('a@b.com', null, 's1')
    expect(r.outcome).toBe(ProviderOutcome.MISS)
    expect(r.charged).toBe(false)
    expect(f).toHaveBeenCalledTimes(1) // resolved inline, no separate poll call
  })

  it('poll DEBITED → mapped + charged', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resp(200, { items: [{ status: 'DEBITED', results: { fullname: 'Jane Doe', jobTitle: 'Designer', company: 'StudioX', linkedin: 'https://li/in/z' } }] })))
    const r = await new IcypeasClient('k').poll('p_123')
    expect([ProviderOutcome.PARTIAL, ProviderOutcome.COMPLETE]).toContain(r.outcome)
    expect(r.fields.li_job_title).toBe('Designer')
    expect(r.charged).toBe(true)
    expect(r.fullName).toBe('Jane Doe')
  })

  it('poll IN_PROGRESS → PENDING; NOT_FOUND → MISS; BAD_INPUT → ERROR; FOUND → mapped', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resp(200, { items: [{ status: 'IN_PROGRESS' }] })))
    expect((await new IcypeasClient('k').poll('p')).outcome).toBe(ProviderOutcome.PENDING)
    vi.stubGlobal('fetch', vi.fn(async () => resp(200, { items: [{ status: 'NOT_FOUND' }] })))
    expect((await new IcypeasClient('k').poll('p')).outcome).toBe(ProviderOutcome.MISS)
    vi.stubGlobal('fetch', vi.fn(async () => resp(200, { items: [{ status: 'BAD_INPUT' }] })))
    expect((await new IcypeasClient('k').poll('p')).outcome).toBe(ProviderOutcome.ERROR)
    // 'FOUND' is a success status alongside 'DEBITED' (api-doc search_statuses)
    vi.stubGlobal('fetch', vi.fn(async () => resp(200, { items: [{ status: 'FOUND', results: { jobTitle: 'Eng', company: 'Co', linkedin: 'https://li/in/q' } }] })))
    expect((await new IcypeasClient('k').poll('p')).charged).toBe(true)
  })
})

// ── Dropcontact client (async, poll) ─────────────────────────────────────────────
describe('DropcontactClient', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('submit → PENDING + request_id; splits name; X-Access-Token header', async () => {
    const f = vi.fn(async (_u: string, _i: any) => resp(200, { error: false, request_id: 'req_77', success: true }))
    vi.stubGlobal('fetch', f)
    const r = await new DropcontactClient('k').enrich('a@b.com', 'Jane Mary Doe', 's1')
    expect(r.outcome).toBe(ProviderOutcome.PENDING)
    expect(r.asyncReference).toBe('req_77')
    const init = f.mock.calls[0]![1]
    expect(init.headers['X-Access-Token']).toBe('k')
    const row = JSON.parse(init.body).data[0]
    expect(row.first_name).toBe('Jane')
    expect(row.last_name).toBe('Mary Doe')
  })

  it('poll not-ready → PENDING; ready → mapped', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resp(200, { success: false, error: false, reason: 'Request not ready yet, try again in 30 seconds' })))
    expect((await new DropcontactClient('k').poll('req_77')).outcome).toBe(ProviderOutcome.PENDING)
    vi.stubGlobal('fetch', vi.fn(async () => resp(200, { success: true, error: false, data: [{ job: 'Architect', company: 'Gensler', website: 'gensler.com', linkedin: 'https://li/in/x' }] })))
    const r = await new DropcontactClient('k').poll('req_77')
    expect(r.outcome).toBe(ProviderOutcome.PARTIAL)
    expect(r.fields.li_current_employer_domain).toBe('gensler.com')
    expect(r.charged).toBe(true)
  })

  it('no key → MISS', async () => {
    vi.stubGlobal('fetch', vi.fn())
    expect((await new DropcontactClient('').enrich('a@b.com', 'Jane', 's1')).outcome).toBe(ProviderOutcome.MISS)
  })
})
