/**
 * Sync enrichment provider clients — TS port of the Part 1.2–1.5 clients. Each is a thin fetch
 * wrapper → canonical mapper → classifyCompleteness. Keys are injected (constructor) so the same
 * code runs in a Next route or a Supabase Edge Function worker.
 */
import {
  classifyCompleteness, makeResult, ProviderOutcome, stripToCanonical,
  type EnrichmentProvider, type ProviderResult,
} from './base'
import { mapApolloPerson, mapDatagmaPerson, mapFindymailPerson, mapHunterPerson, mapPdlPerson, mapReverseContactPerson } from './mappers'

const PDL_BASE = 'https://api.peopledatalabs.com/v5'
const APOLLO_BASE = 'https://api.apollo.io/api/v1'

/** Process-wide rate limiter: ≥ 1/rps seconds between acquisitions. */
class TokenBucket {
  private next = 0
  constructor(private minIntervalMs: number) {}
  async acquire(): Promise<void> {
    const now = Date.now()
    const wait = this.next - now
    if (wait > 0) await new Promise(r => setTimeout(r, wait))
    this.next = Math.max(now, this.next) + this.minIntervalMs
  }
}

// ── Hunter (Part 1.2) ──────────────────────────────────────────────────────────
export class HunterClient implements EnrichmentProvider {
  readonly providerKey = 'hunter'
  readonly executionMode = 'sync' as const
  constructor(private apiKey: string) {}
  async enrich(email: string, _name: string | null = null, _subscriberId = ''): Promise<ProviderResult> {
    if (!this.apiKey) return makeResult(this.providerKey, ProviderOutcome.MISS)
    try {
      const resp = await fetch(`https://api.hunter.io/v2/people/find?email=${encodeURIComponent(email)}&api_key=${encodeURIComponent(this.apiKey)}`)
      if (resp.status === 404) return makeResult(this.providerKey, ProviderOutcome.MISS)
      if (!resp.ok) throw new Error(`hunter ${resp.status}`)
      const data = (await resp.json())?.data ?? {}
      const fields = mapHunterPerson(data)
      const outcome = classifyCompleteness(fields)
      if (outcome === ProviderOutcome.MISS) return makeResult(this.providerKey, ProviderOutcome.MISS)
      return makeResult(this.providerKey, outcome, { fields, charged: true, costUsd: 0.004, fullName: data.name?.fullName ?? null })
    } catch (e) {
      return makeResult(this.providerKey, ProviderOutcome.ERROR, { errorMessage: String(e) })
    }
  }
}

// ── Findymail (V3 Part 1.1) — sync reverse-email specialist ─────────────────────
// POST https://app.findymail.com/api/search/reverse-email  {email, with_profile:true}, Bearer.
// 2 credits with profile; charge-on-success. No education/dates in the documented response → PARTIAL
// by default (keeps the cascade going). Endpoint verified against findymail.com/api (2026-06-23).
export class FindymailClient implements EnrichmentProvider {
  readonly providerKey = 'findymail'
  readonly executionMode = 'sync' as const
  constructor(private apiKey: string) {}
  async enrich(email: string, _name: string | null = null, _subscriberId = ''): Promise<ProviderResult> {
    if (!this.apiKey) return makeResult(this.providerKey, ProviderOutcome.MISS)
    try {
      const resp = await fetch('https://app.findymail.com/api/search/reverse-email', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, with_profile: true }),
      })
      // 401/402/403 = misconfigured/credits → skip cleanly; 404/422 = no match. All MISS, no charge.
      if ([401, 402, 403, 404, 422].includes(resp.status)) return makeResult(this.providerKey, ProviderOutcome.MISS)
      if (!resp.ok) throw new Error(`findymail ${resp.status}`)
      const body = (await resp.json()) ?? {}
      if (process.env.LYCERT_BENCH_DEBUG) console.error('[bench] findymail raw', JSON.stringify(body))
      const payload = body.contact ?? body.profile ?? body // provider may wrap the profile
      const fields = mapFindymailPerson(typeof payload === 'object' && payload ? payload : {})
      const outcome = classifyCompleteness(fields)
      if (outcome === ProviderOutcome.MISS) return makeResult(this.providerKey, ProviderOutcome.MISS)
      return makeResult(this.providerKey, outcome, {
        fields, charged: true, costUsd: 0.02, fullName: payload?.fullName ?? null,
      })
    } catch (e) {
      return makeResult(this.providerKey, ProviderOutcome.ERROR, { errorMessage: String(e) })
    }
  }
}

// ── ReverseContact (Part 1.3) — 15 rps ──────────────────────────────────────────
const rcBucket = new TokenBucket(1000 / 15)
export class ReverseContactClient implements EnrichmentProvider {
  readonly providerKey = 'reversecontact'
  readonly executionMode = 'sync' as const
  constructor(private apiKey: string) {}
  async enrich(email: string, _name: string | null = null, _subscriberId = ''): Promise<ProviderResult> {
    if (!this.apiKey) return makeResult(this.providerKey, ProviderOutcome.MISS)
    await rcBucket.acquire()
    try {
      const resp = await fetch(`https://api.reversecontact.com/enrichment?apikey=${encodeURIComponent(this.apiKey)}&mail=${encodeURIComponent(email)}`)
      if (!resp.ok) throw new Error(`reversecontact ${resp.status}`)
      const body = (await resp.json()) ?? {}
      if (!body.success) return makeResult(this.providerKey, ProviderOutcome.MISS, { charged: true, costUsd: 0.03 })
      const fields = mapReverseContactPerson(body)
      const person = body.person ?? {}
      const fullName = [person.firstName, person.lastName].filter(Boolean).join(' ') || null
      return makeResult(this.providerKey, classifyCompleteness(fields), { fields, charged: true, costUsd: 0.03, fullName })
    } catch (e) {
      return makeResult(this.providerKey, ProviderOutcome.ERROR, { errorMessage: String(e) })
    }
  }
}

// ── Datagma (Part 1.4) — phoneFull never true ──────────────────────────────────
export class DatagmaClient implements EnrichmentProvider {
  readonly providerKey = 'datagma'
  readonly executionMode = 'sync' as const
  constructor(private apiKey: string) {}
  async enrich(email: string, _name: string | null = null, _subscriberId = ''): Promise<ProviderResult> {
    if (!this.apiKey) return makeResult(this.providerKey, ProviderOutcome.MISS)
    try {
      // `data` is Datagma's input param (auto-detects email/LinkedIn/name) — NOT `email` (that 400s
      // "data field must have value"). personFull=true is required to get education + past experience
      // (the reason Datagma is in the cascade — it's the one provider that can yield a COMPLETE result).
      const qs = new URLSearchParams({ apiId: this.apiKey, data: email, personFull: 'true', companyPremium: 'false', phoneFull: 'false' })
      const resp = await fetch(`https://gateway.datagma.net/api/ingress/v2/full?${qs}`)
      // 404/422 = not found; 400 = Datagma declines the domain ("This email is not accepted" — it rejects
      // free/personal & some edu providers). All are clean MISSes (no charge), not errors.
      if (resp.status === 400 || resp.status === 404 || resp.status === 422) return makeResult(this.providerKey, ProviderOutcome.MISS)
      if (!resp.ok) throw new Error(`datagma ${resp.status}`)
      const body = (await resp.json()) ?? {}
      const fields = mapDatagmaPerson(body)
      const outcome = classifyCompleteness(fields)
      if (outcome === ProviderOutcome.MISS) return makeResult(this.providerKey, ProviderOutcome.MISS)
      return makeResult(this.providerKey, outcome, { fields, charged: true, costUsd: 0.03, fullName: body.person?.basic?.fullName ?? null })
    } catch (e) {
      return makeResult(this.providerKey, ProviderOutcome.ERROR, { errorMessage: String(e) })
    }
  }
}

// ── PDL (Part 1.5) — position 4 ─────────────────────────────────────────────────
export class PdlClient implements EnrichmentProvider {
  readonly providerKey = 'pdl'
  readonly executionMode = 'sync' as const
  constructor(private apiKey: string) {}
  async enrich(email: string, name: string | null): Promise<ProviderResult> {
    if (!this.apiKey) return makeResult(this.providerKey, ProviderOutcome.MISS)
    try {
      const qs = new URLSearchParams({ email, min_likelihood: '4', required: 'experience AND education', pretty: 'false' })
      if (name) qs.set('name', name)
      const resp = await fetch(`${PDL_BASE}/person/enrich?${qs}`, { headers: { 'X-Api-Key': this.apiKey } })
      if (resp.status === 404) return makeResult(this.providerKey, ProviderOutcome.MISS)
      if (!resp.ok) throw new Error(`pdl ${resp.status}`)
      const body = await resp.json()
      const fields = mapPdlPerson(body.data ?? {}, body.likelihood ?? 0)
      return makeResult(this.providerKey, classifyCompleteness(fields), {
        fields, charged: true, costUsd: 0.28, fullName: body.data?.full_name ?? null,
      })
    } catch (e) {
      return makeResult(this.providerKey, ProviderOutcome.ERROR, { errorMessage: String(e) })
    }
  }
}

// ── Apollo — DISABLED in the registry; kept for re-enable ───────────────────────
export class ApolloClient implements EnrichmentProvider {
  readonly providerKey = 'apollo'
  readonly executionMode = 'sync' as const
  constructor(private apiKey: string) {}
  async enrich(email: string, name: string | null): Promise<ProviderResult> {
    if (!this.apiKey) return makeResult(this.providerKey, ProviderOutcome.MISS)
    try {
      // Apollo authenticates with the X-Api-Key header (query/body keys dropped Sept 2024); a
      // Bearer token returns 401. https://docs.apollo.io/reference/authentication
      const resp = await fetch(`${APOLLO_BASE}/people/match`, {
        method: 'POST',
        headers: { 'X-Api-Key': this.apiKey, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
        body: JSON.stringify({ email, name }),
      })
      if ([404, 422, 429].includes(resp.status)) return makeResult(this.providerKey, ProviderOutcome.MISS)
      if (!resp.ok) throw new Error(`apollo ${resp.status}`)
      const person = (await resp.json())?.person ?? null
      if (!person) return makeResult(this.providerKey, ProviderOutcome.MISS)
      const fields = stripToCanonical(mapApolloPerson(person))
      return makeResult(this.providerKey, classifyCompleteness(fields), { fields, charged: true, costUsd: 0, fullName: person.name ?? null })
    } catch (e) {
      return makeResult(this.providerKey, ProviderOutcome.ERROR, { errorMessage: String(e) })
    }
  }
}
