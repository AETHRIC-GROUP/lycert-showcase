import { type NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '@/lib/enrichment/worker-io'
import { resolveTimedOutPending, type ExistingEnrichment } from '@/lib/enrichment/fullenrich-webhook'
import { applyFullenrichItem } from '@/lib/enrichment/fullenrich-apply'
import { FullEnrichClient, parseWebhookResults } from '@/lib/enrichment/providers/fullenrich'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

const TIMEOUT_HOURS = 24
const MAX_PER_RUN = 50 // bound the sequential polls within maxDuration

type PendingRow = ExistingEnrichment & {
  subscriber_id: string
  async_reference: string | null
  async_submitted_at: string | null
  enriched_at: string | null
}

/**
 * FullEnrich pending sweep (V2 §4.3) — RECONCILE then TIMEOUT. The webhook is the primary, instant
 * result path; this is the safety net for callbacks that never arrive (e.g. the 2026-06-21
 * misconfigured-webhook incident):
 *   1. For each subscriber pending on fullenrich WITH a stored `async_reference`, POLL FullEnrich.
 *      FINISHED → apply the result (recovers data the webhook never delivered; idempotent with it).
 *   2. Still in progress → leave it.
 *   3. Older than 24h (or no reference to poll — legacy rows) → time it out so it doesn't block
 *      future re-enrichment.
 * Invoked by pg_cron with the shared CRON_SECRET (same as the workers).
 */
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = serviceClient()
  const client = new FullEnrichClient(process.env.LYCERT_FULLENRICH_API_KEY ?? '', '', null)
  const cutoffMs = TIMEOUT_HOURS * 3600 * 1000
  const now = Date.now()

  const { data, error } = await db
    .from('subscriber_enrichment')
    .select('subscriber_id, async_reference, async_submitted_at, enriched_at, providers_attempted, pending_async_provider, tenant_id')
    .eq('pending_async_provider', 'fullenrich')
    .limit(MAX_PER_RUN)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows = (data ?? []) as unknown as PendingRow[]
  let reconciled = 0
  let matched = 0
  let timedOut = 0
  let inProgress = 0

  for (const row of rows) {
    const submittedAt = new Date(row.async_submitted_at ?? row.enriched_at ?? 0).getTime()
    const aged = now - submittedAt > cutoffMs

    // 1) Try to recover via poll when we have a reference.
    if (row.async_reference) {
      const poll = await client.pollBulk(row.async_reference)
      if (poll.status === 'FINISHED' && poll.payload) {
        const item = parseWebhookResults(poll.payload).find(i => i.subscriberId === row.subscriber_id)
        if (item) {
          try {
            const r = await applyFullenrichItem(db, item)
            if (r.applied) { reconciled++; if (r.matched) matched++ }
            continue
          } catch (e) {
            console.error('[fullenrich-timeout] reconcile failed for %s: %s', row.subscriber_id, String(e))
            // fall through to the age check rather than retrying forever
          }
        }
      } else if (!aged) {
        inProgress++
        continue // still processing — give the webhook/next poll a chance
      }
    }

    // 2) No reference, or aged out without finishing → time it out.
    if (aged) {
      const res = resolveTimedOutPending(row)
      if (res) {
        const { error: upErr } = await db
          .from('subscriber_enrichment')
          .update(res.update)
          .eq('subscriber_id', row.subscriber_id)
          .eq('pending_async_provider', 'fullenrich') // guard against a concurrent webhook landing
        if (!upErr) timedOut++
      }
    } else {
      inProgress++
    }
  }

  console.log('[enrichment/fullenrich-timeout] pending=%d reconciled=%d matched=%d timedOut=%d inProgress=%d',
    rows.length, reconciled, matched, timedOut, inProgress)
  return NextResponse.json({ ok: true, pending: rows.length, reconciled, matched, timedOut, inProgress })
}
