/**
 * ZeroBounce — Stage 0 email validation gate. TS port of zerobounce_client.py (Part 1.1).
 * Auth: api_key query param; ip_address always sent empty. Never blocks on outage/missing key.
 */
const BASE = 'https://api.zerobounce.net/v2'
const COST = 0.006

// Stage-0 gate POLICY — which normalized validation statuses block paid enrichment.
// Decision 2026-06-21 (see DECISIONS.md): block ONLY `disposable`. A throwaway address has no real
// person behind it, so spending credits is pure waste. `invalid` (undeliverable mailbox) is NOT
// blocked: enrichment feeds the SCORING engine, not email delivery, and Benchmark Run 1 showed the one
// subscriber PDL could enrich (haverford) was flagged `invalid (mailbox_not_found)` — a naive
// invalid-block would discard a genuine hit. Flip this set to re-enable invalid-blocking.
const BLOCKING = new Set<string>(['disposable'])

export type ValidationResult = {
  rawStatus: string
  status: string // normalised for subscribers.email_validation_status
  subStatus: string
  freeEmail: boolean
  didYouMean: string | null
  blocksEnrichment: boolean
  emailDomainTypeOverride: string | null // 'disposable' when sub_status indicates disposable
  costUsd: number
}

export function interpret(item: Record<string, any>): ValidationResult {
  const raw = String(item.status ?? '').trim().toLowerCase()
  const sub = String(item.sub_status ?? '').trim().toLowerCase()
  const didYouMean = item.did_you_mean || null
  const freeEmail = Boolean(item.free_email)
  const base = { rawStatus: raw, subStatus: sub, freeEmail, didYouMean, costUsd: COST }

  // Status normalization is independent of the block POLICY: we always record the true status into
  // subscribers.email_validation_status (so 'invalid' stays 'invalid' for the audit/cache), and decide
  // blocking purely from the BLOCKING set above. This keeps the cached status accurate even if the
  // policy changes later.
  const isDisposable = sub === 'disposable'
  const status = isDisposable ? 'disposable'
    : raw === 'invalid' ? 'invalid'
    : raw === 'catch-all' ? 'catch_all'
    : raw === 'valid' ? 'valid'
    : raw === 'unknown' ? 'unknown'
    : (raw || 'unknown')
  return {
    ...base,
    status,
    blocksEnrichment: BLOCKING.has(status),
    emailDomainTypeOverride: isDisposable ? 'disposable' : null,
  }
}

export const BLOCKING_VALIDATION_STATUSES = BLOCKING

export class ZeroBounceClient {
  readonly providerKey = 'zerobounce'
  readonly executionMode = 'sync' as const
  constructor(private apiKey: string) {}

  async validate(email: string): Promise<ValidationResult> {
    if (!this.apiKey) {
      return { rawStatus: 'no_key', status: 'unknown', subStatus: '', freeEmail: false, didYouMean: null, blocksEnrichment: false, emailDomainTypeOverride: null, costUsd: 0 }
    }
    try {
      const url = `${BASE}/validate?api_key=${encodeURIComponent(this.apiKey)}&email=${encodeURIComponent(email)}&ip_address=`
      const resp = await fetch(url)
      if (!resp.ok) throw new Error(`zerobounce ${resp.status}`)
      return interpret(await resp.json())
    } catch {
      // Permissive: an outage never blocks coverage.
      return { rawStatus: 'error', status: 'unknown', subStatus: '', freeEmail: false, didYouMean: null, blocksEnrichment: false, emailDomainTypeOverride: null, costUsd: 0 }
    }
  }
}
