import { type NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { serviceClient } from '@/lib/enrichment/worker-io'
import { parseWebhookResults } from '@/lib/enrichment/providers/fullenrich'
import { applyFullenrichItem } from '@/lib/enrichment/fullenrich-apply'

export const runtime = 'nodejs'
export const maxDuration = 60

/** Constant-time string equality (lengths differing → false, without early-out). */
function tokenEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * FullEnrich async result receiver (V2 §4.3). FullEnrich POSTs enrichment results here minutes after
 * the cascade submitted them. FullEnrich does NOT sign webhooks, so authenticity is a shared-secret
 * token embedded in the webhook URL we submitted (?token=LYCERT_FULLENRICH_WEBHOOK_SECRET). Idempotent:
 * a result is applied only while the subscriber is still pending on fullenrich, so retries are safe.
 *
 * 200 on a processed payload (even with per-item skips); 401 on bad/missing token; 500 only on an
 * unexpected fault so FullEnrich retries (idempotency makes that safe).
 */
export async function POST(req: NextRequest) {
  const secret = process.env.LYCERT_FULLENRICH_WEBHOOK_SECRET ?? ''
  const token = req.nextUrl.searchParams.get('token') ?? ''
  if (!secret || !tokenEquals(token, secret)) {
    return NextResponse.json({ error: 'invalid token' }, { status: 401 })
  }

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(await req.text())
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const items = parseWebhookResults(payload)
  const db = serviceClient()

  let applied = 0
  let skipped = 0
  let matched = 0

  try {
    for (const item of items) {
      const r = await applyFullenrichItem(db, item)
      if (!r.applied) { skipped++; continue }
      applied++
      if (r.matched) matched++
    }
  } catch (e) {
    // Return 500 so FullEnrich retries; the pending-guard makes already-applied items no-ops on retry.
    console.error('[enrichment/webhook/fullenrich] error after %d applied: %s', applied, String(e))
    return NextResponse.json({ error: 'processing failed', applied, skipped }, { status: 500 })
  }

  console.log('[enrichment/webhook/fullenrich] items=%d applied=%d matched=%d skipped=%d',
    items.length, applied, matched, skipped)
  return NextResponse.json({ ok: true, items: items.length, applied, matched, skipped })
}
