/**
 * Icypeas — V3 waterfall Step 3 (async, POLL-based reverse-email specialist).
 *
 * LYCERT_WATERFALL_ENRICHMENT_V3.md Part 1.2. EU; GDPR/CCPA/ISO 27001; OSINT only. Reverse lookup
 * costs 10 credits → the registry gates it to enrichment_priority >= 40 (the cascade applies the gate;
 * this client only submits/polls).
 *
 * POLL-based async (NOT a webhook like FullEnrich), endpoints verified against api-doc.icypeas.com
 * (re-confirmed 2026-06-25):
 *   SUBMIT: POST https://app.icypeas.com/api/reverse-email-lookup   Authorization: {raw key}
 *           body {"email","userData":{"externalId":"<subscriber_id>"}} → {success,item:{status,_id}}
 *   POLL:   POST https://app.icypeas.com/api/bulk-single-searchs/read   body {"id":"<_id>"}
 *           → {items:[{results, status, userData}]}
 * Status (api-doc.icypeas.com/how-works/search_statuses): NONE/SCHEDULED/IN_PROGRESS = keep polling;
 * FOUND/DEBITED = found+charged; NOT_FOUND/DEBITED_NOT_FOUND = no match (free);
 * BAD_INPUT/INSUFFICIENT_FUNDS/ABORTED = error. Reverse lookup = 10 credits/found (50 free on signup).
 */
import { classifyCompleteness, makeResult, ProviderOutcome, type EnrichmentProvider, type ProviderResult } from './base'
import { mapIcypeasResults } from './mappers'

const SUBMIT_URL = 'https://app.icypeas.com/api/reverse-email-lookup'
const POLL_URL = 'https://app.icypeas.com/api/bulk-single-searchs/read'
const COST_PER_SUCCESS = 0.19 // 10 credits ≈ $0.19 at the entry tier

const POLLING = new Set(['NONE', 'SCHEDULED', 'IN_PROGRESS'])
const SUCCESS = new Set(['DEBITED', 'FOUND'])
const NO_MATCH = new Set(['NOT_FOUND', 'DEBITED_NOT_FOUND'])
const ERRORS = new Set(['BAD_INPUT', 'INSUFFICIENT_FUNDS', 'ABORTED'])

export class IcypeasClient implements EnrichmentProvider {
  readonly providerKey = 'icypeas'
  readonly executionMode = 'async' as const
  constructor(private apiKey: string) {}

  /** Submit the reverse lookup; return PENDING + the Icypeas item _id. The poller resolves it. */
  async enrich(email: string, _name: string | null, subscriberId: string): Promise<ProviderResult> {
    if (!this.apiKey) return makeResult(this.providerKey, ProviderOutcome.MISS)
    try {
      const resp = await fetch(SUBMIT_URL, {
        method: 'POST',
        headers: { Authorization: this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, userData: { externalId: String(subscriberId) } }),
      })
      const text = await resp.text()
      if (process.env.LYCERT_BENCH_DEBUG) console.error('[bench] icypeas submit', resp.status, text.slice(0, 800))
      let body: any = {}
      try { body = text ? JSON.parse(text) : {} } catch { /* non-JSON body */ }
      if (!resp.ok) return makeResult(this.providerKey, ProviderOutcome.ERROR, { errorMessage: `submit ${resp.status}: ${text.slice(0, 160)}` })
      // Reverse-email-lookup answers INLINE in the submit response (observed 2026-06-25:
      // {success, searchId, status, result}). A terminal status (NOT_FOUND/FOUND/…) → resolve now;
      // only an in-progress status (NONE/SCHEDULED/IN_PROGRESS) needs the poll() path via searchId.
      const ref = body?.searchId ?? body?.item?._id ?? body?._id ?? body?.id ?? null
      const status = String(body?.status ?? body?.item?.status ?? '').toUpperCase()
      if (status && !POLLING.has(status)) return this.terminal(status, body?.result ?? body?.results)
      if (!ref) return makeResult(this.providerKey, ProviderOutcome.ERROR, { errorMessage: `no searchId: ${text.slice(0, 160)}` })
      return makeResult(this.providerKey, ProviderOutcome.PENDING, { asyncReference: ref, charged: false })
    } catch (e) {
      return makeResult(this.providerKey, ProviderOutcome.ERROR, { errorMessage: String(e) })
    }
  }

  /** Poll one submitted job. PENDING while still processing; terminal otherwise. */
  async poll(reference: string): Promise<ProviderResult> {
    if (!this.apiKey || !reference) return makeResult(this.providerKey, ProviderOutcome.ERROR, { errorMessage: 'no key/ref' })
    try {
      const resp = await fetch(POLL_URL, {
        method: 'POST',
        headers: { Authorization: this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: reference }),
      })
      if (!resp.ok) throw new Error(`icypeas poll ${resp.status}`)
      const body = (await resp.json()) ?? {}
      const item = (body.items ?? [])[0]
      if (!item) return makeResult(this.providerKey, ProviderOutcome.PENDING)
      const status = String(item.status ?? '').toUpperCase()
      if (process.env.LYCERT_BENCH_DEBUG) console.error('[bench] icypeas poll', status, JSON.stringify(item))
      if (POLLING.has(status)) return makeResult(this.providerKey, ProviderOutcome.PENDING)
      return this.terminal(status, item.results ?? item.result)
    } catch (e) {
      return makeResult(this.providerKey, ProviderOutcome.ERROR, { errorMessage: String(e) })
    }
  }

  /** Resolve a terminal Icypeas status + profile object → ProviderResult. Shared by the inline
   * (submit) and polled paths. The FOUND profile shape is mapped defensively: no live FOUND was
   * observed on this population (all NOT_FOUND), so confirm against a real hit before relying on it. */
  private terminal(status: string, profile: any): ProviderResult {
    if (ERRORS.has(status)) return makeResult(this.providerKey, ProviderOutcome.ERROR, { errorMessage: status })
    if (NO_MATCH.has(status)) return makeResult(this.providerKey, ProviderOutcome.MISS)
    if (!SUCCESS.has(status)) return makeResult(this.providerKey, ProviderOutcome.MISS) // unknown terminal → miss
    const results = profile && typeof profile === 'object' ? profile : {}
    const fields = mapIcypeasResults(results)
    const outcome = classifyCompleteness(fields)
    if (outcome === ProviderOutcome.MISS) return makeResult(this.providerKey, ProviderOutcome.MISS, { charged: true, costUsd: COST_PER_SUCCESS })
    const fullName = results.fullname ?? [results.firstname, results.lastname].filter(Boolean).join(' ') ?? null
    return makeResult(this.providerKey, outcome, { fields, charged: true, costUsd: COST_PER_SUCCESS, fullName: fullName || null })
  }
}
