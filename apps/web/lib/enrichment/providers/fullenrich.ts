/**
 * FullEnrich — async waterfall-of-waterfalls final sweep (Part 1.6). Reverse-email bulk endpoint,
 * confirmed against docs.fullenrich.com (2026-06-21).
 *
 * Auth of the inbound webhook: FullEnrich does NOT sign webhooks (no HMAC/signature documented), so
 * we authenticate by embedding a shared secret token in the `webhook_url` we submit
 * (?token=LYCERT_FULLENRICH_WEBHOOK_SECRET); the receiver verifies it. See DECISIONS.md 2026-06-21.
 */
import { makeResult, ProviderOutcome, type ProviderResult } from './base'
import { mapFullenrichProfile } from './mappers'

const BASE = 'https://app.fullenrich.com/api/v2'
const SUBMIT_URL = `${BASE}/contact/reverse/email/bulk`
const COST_PER_SUCCESS = 0.05
const BULK_MAX = 100

function appendParam(url: string, key: string, value: string | undefined): string {
  if (!url || !value) return url
  return url + (url.includes('?') ? '&' : '?') + key + '=' + encodeURIComponent(value)
}

/**
 * Build the webhook URL FullEnrich will POST back to. Appends our shared-secret `token` (receiver
 * auth) and, when staging is behind Vercel Deployment Protection, the `x-vercel-protection-bypass`
 * query param so the callback isn't walled by Vercel SSO before reaching the function. Both are read
 * from env; absent env vars are simply omitted (e.g. unprotected production needs no bypass).
 */
export function withWebhookToken(
  url: string,
  token: string | undefined = process.env.LYCERT_FULLENRICH_WEBHOOK_SECRET,
  bypass: string | undefined = process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
): string {
  let out = appendParam(url, 'token', token)
  out = appendParam(out, 'x-vercel-protection-bypass', bypass)
  return out
}

export type FullEnrichContact = { email: string; subscriberId: string }

export class FullEnrichClient {
  readonly providerKey = 'fullenrich'
  readonly executionMode = 'async' as const
  constructor(private apiKey: string, private webhookUrl: string, private jobId: string | null = null) {}

  async submitBulk(contacts: FullEnrichContact[]): Promise<{ enrichmentId: string | null; submitted: number; error?: string }> {
    if (!contacts.length) return { enrichmentId: null, submitted: 0 }
    if (contacts.length > BULK_MAX) throw new Error(`FullEnrich bulk accepts max ${BULK_MAX} contacts`)
    if (!this.apiKey) return { enrichmentId: null, submitted: 0, error: 'no api key' }
    const data = contacts.map(c => ({
      email: c.email,
      custom: { lycert_subscriber_id: String(c.subscriberId), ...(this.jobId ? { lycert_job_id: String(this.jobId) } : {}) },
    }))
    const hookUrl = withWebhookToken(this.webhookUrl) // carries the shared-secret token for receiver auth
    try {
      const resp = await fetch(SUBMIT_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `lycert_batch_${this.jobId ?? 'adhoc'}`,
          webhook_url: hookUrl,
          webhook_events: { contact_finished: hookUrl },
          data,
        }),
      })
      if (!resp.ok) throw new Error(`fullenrich ${resp.status}`)
      const enrichmentId = (await resp.json())?.enrichment_id ?? null
      return { enrichmentId, submitted: data.length }
    } catch (e) {
      return { enrichmentId: null, submitted: 0, error: String(e) }
    }
  }

  /** Single-subscriber async handoff: submit one, return PENDING + enrichment_id. */
  async enrich(email: string, _name: string | null, subscriberId: string): Promise<ProviderResult> {
    const res = await this.submitBulk([{ email, subscriberId }])
    if (!res.enrichmentId) return makeResult(this.providerKey, ProviderOutcome.ERROR, { errorMessage: res.error ?? null })
    return makeResult(this.providerKey, ProviderOutcome.PENDING, { asyncReference: res.enrichmentId, costUsd: COST_PER_SUCCESS, charged: false })
  }

  /**
   * Poll a submitted bulk job. The GET payload is the same `{status, data[]}` shape the webhook POSTs,
   * so the result feeds parseWebhookResults() unchanged — this is the fallback reconciler for when a
   * webhook never arrives. No credit cost (charging is per-match at submit). status is e.g.
   * IN_PROGRESS / FINISHED.
   */
  async pollBulk(enrichmentId: string): Promise<{ status: string | null; payload: Record<string, any> | null }> {
    if (!this.apiKey || !enrichmentId) return { status: null, payload: null }
    try {
      const resp = await fetch(`${SUBMIT_URL}/${encodeURIComponent(enrichmentId)}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      })
      if (!resp.ok) return { status: null, payload: null }
      const payload = await resp.json()
      return { status: payload?.status ?? null, payload }
    } catch {
      return { status: null, payload: null }
    }
  }
}

export type WebhookResultItem = { subscriberId: string; jobId: string | null; fields: Record<string, unknown>; fullName: string | null; matched: boolean }

/**
 * Extract per-contact results from a FullEnrich payload. Identical `data[]` of {input, custom,
 * contact_info, profile} arrives via both the webhook POST and the GET poll, so this parses both.
 * The enriched data is in `item.profile` (NOT `item.contact`). `profile.full_name` feeds the merge
 * wrong-person guard. contact_info (emails/phones) is intentionally ignored (GDPR, Part 9).
 */
export function parseWebhookResults(payload: Record<string, any>): WebhookResultItem[] {
  const items = payload.data ?? payload.datas ?? []
  const out: WebhookResultItem[] = []
  for (const item of items) {
    const custom = item.custom ?? {}
    const subscriberId = custom.lycert_subscriber_id
    if (!subscriberId) continue
    const profile = item.profile ?? null
    const fields = profile ? mapFullenrichProfile(profile) : {}
    out.push({
      subscriberId,
      jobId: custom.lycert_job_id ?? null,
      fields,
      fullName: profile?.full_name ?? null,
      matched: Object.keys(fields).length > 0,
    })
  }
  return out
}
