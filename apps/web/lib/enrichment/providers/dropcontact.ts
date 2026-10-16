/**
 * Dropcontact — V3 waterfall Step 4 (async, POLL-based; name+company, NOT reverse-email).
 *
 * LYCERT_WATERFALL_ENRICHMENT_V3.md Part 1.3. #1 accuracy / lowest error in the independent 20k
 * benchmark; EU-strong. Input modality is NAME + company, so the cascade hard-skips it for bare-email
 * subscribers (registry requires_name_company=true). Charge-on-success.
 *
 * Endpoints VERIFIED against developer.dropcontact.com (2026-06-23) — note this differs from the V3
 * spec's draft (api.dropcontact.io/batch); the live API is:
 *   SUBMIT: POST https://api.dropcontact.com/v1/enrich/all   X-Access-Token
 *           body {"data":[{first_name,last_name,email,company,website}],"siren":true} → {request_id}
 *   POLL:   GET  https://api.dropcontact.com/v1/enrich/all/{request_id}   X-Access-Token
 *           not ready → {success:false, reason:"..."}; ready → {data:[{job,company,website,linkedin}]}
 */
import { classifyCompleteness, makeResult, ProviderOutcome, type EnrichmentProvider, type ProviderResult } from './base'
import { mapDropcontactRecord } from './mappers'

const SUBMIT_URL = 'https://api.dropcontact.com/v1/enrich/all'
const COST_PER_SUCCESS = 0.06 // ~€29/500 credits; charge-on-success

function splitName(name: string | null): { first?: string; last?: string } {
  if (!name || !name.trim()) return {}
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return { first: parts[0] }
  return { first: parts[0], last: parts.slice(1).join(' ') }
}

export class DropcontactClient implements EnrichmentProvider {
  readonly providerKey = 'dropcontact'
  readonly executionMode = 'async' as const
  constructor(private apiKey: string) {}

  /** Submit a one-row batch; return PENDING + request_id. company/website are optional name+company
   * signals the cascade passes when present. The poller resolves it. */
  async enrich(
    email: string, name: string | null, _subscriberId: string,
    company: string | null = null, website: string | null = null,
  ): Promise<ProviderResult> {
    if (!this.apiKey) return makeResult(this.providerKey, ProviderOutcome.MISS)
    const { first, last } = splitName(name)
    const row: Record<string, string> = { email }
    if (first) row.first_name = first
    if (last) row.last_name = last
    if (company) row.company = company
    if (website) row.website = website
    try {
      const resp = await fetch(SUBMIT_URL, {
        method: 'POST',
        headers: { 'X-Access-Token': this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: [row], siren: true }),
      })
      if (!resp.ok) throw new Error(`dropcontact submit ${resp.status}`)
      const ref = (await resp.json())?.request_id ?? null
      if (!ref) return makeResult(this.providerKey, ProviderOutcome.ERROR, { errorMessage: 'no request_id' })
      return makeResult(this.providerKey, ProviderOutcome.PENDING, { asyncReference: ref, charged: false })
    } catch (e) {
      return makeResult(this.providerKey, ProviderOutcome.ERROR, { errorMessage: String(e) })
    }
  }

  /** Poll a batch by request_id. PENDING while not ready; terminal otherwise. */
  async poll(reference: string): Promise<ProviderResult> {
    if (!this.apiKey || !reference) return makeResult(this.providerKey, ProviderOutcome.ERROR, { errorMessage: 'no key/ref' })
    try {
      const resp = await fetch(`${SUBMIT_URL}/${encodeURIComponent(reference)}`, {
        headers: { 'X-Access-Token': this.apiKey },
      })
      if (!resp.ok) throw new Error(`dropcontact poll ${resp.status}`)
      const body = (await resp.json()) ?? {}
      if (process.env.LYCERT_BENCH_DEBUG) console.error('[bench] dropcontact poll', JSON.stringify(body))
      const records = body.data ?? []
      // Not-ready: success=false with a reason and no data → keep polling.
      if (!body.success && records.length === 0) return makeResult(this.providerKey, ProviderOutcome.PENDING)
      if (records.length === 0) return makeResult(this.providerKey, ProviderOutcome.MISS)

      const rec = records[0]
      const fields = mapDropcontactRecord(rec)
      const outcome = classifyCompleteness(fields)
      if (outcome === ProviderOutcome.MISS) return makeResult(this.providerKey, ProviderOutcome.MISS)
      const fullName = [rec.first_name, rec.last_name].filter(Boolean).join(' ') || rec.full_name || null
      return makeResult(this.providerKey, outcome, { fields, charged: true, costUsd: COST_PER_SUCCESS, fullName })
    } catch (e) {
      return makeResult(this.providerKey, ProviderOutcome.ERROR, { errorMessage: String(e) })
    }
  }
}
