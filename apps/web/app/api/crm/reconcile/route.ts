import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '@/lib/enrichment/worker-io'
import { enqueue } from '@/lib/enrichment/queue'
import { CRM_QUEUES } from '@/lib/crm/worker-io'

// POST /api/crm/reconcile — Bridge Part 6.6 nightly reconcile: for every connected tenant with a
// configured segment, starts one `reconcile` run per tenant (since = last_reconcile_at, or epoch on the
// first ever run). CRON_SECRET-gated, invoked by pg_cron (mirrors the other lycert-*-worker schedules).
export const dynamic = 'force-dynamic'
export const maxDuration = 30

const EPOCH = '1970-01-01T00:00:00.000Z'

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return req.headers.get('authorization') === `Bearer ${secret}`
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = serviceClient()
  const { data: connections, error } = await db.from('crm_connections')
    .select('tenant_id, last_reconcile_at').eq('provider', 'hubspot').eq('status', 'connected')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  let started = 0
  for (const conn of connections ?? []) {
    const tenantId = (conn as { tenant_id: string }).tenant_id
    const since = (conn as { last_reconcile_at: string | null }).last_reconcile_at ?? EPOCH

    const { data: seg } = await db.from('crm_segment_config')
      .select('mode').eq('tenant_id', tenantId).eq('provider', 'hubspot').maybeSingle()
    if (!seg || seg.mode !== 'property') continue // nothing to reconcile without a segment configured

    const { data: run, error: runErr } = await db.from('crm_sync_runs')
      .insert({ tenant_id: tenantId, provider: 'hubspot', kind: 'reconcile', status: 'running' })
      .select('id').single()
    if (runErr) { console.error('[crm/reconcile] run start failed for %s: %s', tenantId, runErr.message); continue }

    await enqueue(db as never, CRM_QUEUES.crmSync, [
      { tenantId, kind: 'reconcile_page', runId: (run as { id: string }).id, after: null, since },
    ])
    started++
  }

  return NextResponse.json({ ok: true, started })
}
