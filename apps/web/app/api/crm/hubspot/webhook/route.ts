import { NextRequest, NextResponse } from 'next/server'
import { verifyWebhookSignature } from '@/lib/crm/webhook-signature'
import { parseWebhookBody } from '@/lib/crm/webhook-events'
import { serviceClient } from '@/lib/enrichment/worker-io'
import { enqueue } from '@/lib/enrichment/queue'
import { CRM_QUEUES } from '@/lib/crm/worker-io'
import type { CrmSyncJobMsg } from '@/lib/crm/worker'

// POST /api/crm/hubspot/webhook — Bridge Part 6.6: validates the v3 signature, classifies each event,
// resolves portalId -> tenant, and enqueues one `webhook_event` message per event. NEVER processes
// inline (own rule) — the only work here is verify + parse + enqueue, so this returns fast regardless of
// how much downstream work a batch implies.
export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function POST(req: NextRequest) {
  const rawBody = await req.text()
  const clientSecret = process.env.LYCERT_HUBSPOT_CLIENT_SECRET
  const targetUrl = process.env.LYCERT_HUBSPOT_WEBHOOK_TARGET_URL
  if (!clientSecret || !targetUrl) return NextResponse.json({ error: 'not configured' }, { status: 503 })

  const verified = verifyWebhookSignature({
    method: req.method,
    // Use the literal configured Target URL (webhooks-hsmeta.json), not req.nextUrl — Vercel's serverless
    // functions see the request as plain http:// internally (TLS terminates at the edge), while HubSpot
    // signs against the https:// URL it's configured to call. Reconstructing from the request caused the
    // scheme to mismatch on every single delivery (confirmed via HubSpot's Monitoring > Logs > Webhooks,
    // 100% 401 rate, 2026-10-12).
    url: targetUrl,
    rawBody,
    signatureHeader: req.headers.get('x-hubspot-signature-v3'),
    timestampHeader: req.headers.get('x-hubspot-request-timestamp'),
    clientSecret,
  })
  if (!verified.valid) {
    console.warn('[crm/hubspot/webhook] rejected: %s', verified.reason)
    return NextResponse.json({ error: verified.reason }, { status: 401 })
  }

  const scoped = parseWebhookBody(rawBody)
  if (scoped.length === 0) return NextResponse.json({ ok: true, enqueued: 0 })

  const db = serviceClient()
  const portalIds = Array.from(new Set(scoped.map(s => s.portalId)))
  const { data: connections, error } = await db.from('crm_connections')
    .select('tenant_id, portal_id').eq('provider', 'hubspot').in('portal_id', portalIds)
  if (error) {
    console.error('[crm/hubspot/webhook] connection lookup failed: %s', error.message)
    return NextResponse.json({ error: 'lookup failed' }, { status: 500 })
  }
  const portalToTenant = new Map((connections ?? []).map((c: { tenant_id: string; portal_id: string }) => [c.portal_id, c.tenant_id]))

  const messages: CrmSyncJobMsg[] = []
  for (const { portalId, action } of scoped) {
    const tenantId = portalToTenant.get(portalId)
    if (!tenantId) continue // unknown portal (e.g. a stale/disconnected connection) — drop, not an error
    messages.push({ tenantId, kind: 'webhook_event', action })
  }

  if (messages.length > 0) {
    await enqueue(db as never, CRM_QUEUES.crmSync, messages)
  }
  return NextResponse.json({ ok: true, enqueued: messages.length })
}
