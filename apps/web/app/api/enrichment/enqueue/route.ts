import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { serviceClient } from '@/lib/enrichment/worker-io'
import { enqueue, QUEUES, type RpcClient } from '@/lib/enrichment/queue'
import type { EnrichmentJobMsg } from '@/lib/enrichment/worker'

// POST /api/enrichment/enqueue — owner/admin trigger that creates an enrichment_jobs row and pushes
// one enrichment_jobs_q message per subscriber. The durable worker (pg_cron → /api/enrichment/worker)
// does the actual enrichment in bounded chunks — this handler only enqueues and returns immediately,
// never running long jobs inside the request (ENGINE_CONSOLIDATION_PLAN.md).
//
// Body: { subscriberIds?: string[] }. Omitted → every non-deferred subscriber for the tenant.

export const dynamic = 'force-dynamic'

async function getCtx() {
  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return null
  try {
    const payload = JSON.parse(Buffer.from(session.access_token.split('.')[1], 'base64').toString())
    return {
      tenantId: (payload.tenant_id as string | undefined) ?? null,
      role: (payload.user_role as string | undefined) ?? (payload.role as string | undefined),
    }
  } catch {
    return null
  }
}

export async function POST(req: NextRequest) {
  const ctx = await getCtx()
  if (!ctx?.tenantId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!['owner', 'admin'].includes(ctx.role ?? ''))
    return NextResponse.json({ error: 'Owner or admin role required' }, { status: 403 })

  const body = await req.json().catch(() => null)
  const explicitIds = Array.isArray(body?.subscriberIds) ? (body.subscriberIds as string[]) : null

  const db = serviceClient()

  let ids: string[]
  if (explicitIds) {
    // Restrict to ids that actually belong to this tenant. Archived (soft-deleted) rows are never
    // enriched — the customer asked for them to be removed.
    const { data, error } = await db
      .from('subscribers').select('id').eq('tenant_id', ctx.tenantId).is('deleted_at', null).in('id', explicitIds)
    if (error) return NextResponse.json({ error: 'lookup failed', detail: error.message }, { status: 500 })
    ids = ((data ?? []) as unknown as Array<{ id: string }>).map(r => r.id)
  } else {
    const { data, error } = await db
      .from('subscribers').select('id').eq('tenant_id', ctx.tenantId).is('deleted_at', null).neq('enrichment_deferred', true)
    if (error) return NextResponse.json({ error: 'lookup failed', detail: error.message }, { status: 500 })
    ids = ((data ?? []) as unknown as Array<{ id: string }>).map(r => r.id)
  }

  if (ids.length === 0) return NextResponse.json({ ok: true, enqueued: 0, jobId: null })

  // Create the job row first so messages can reference it for per-provider accounting.
  const { data: job, error: jobErr } = await db
    .from('enrichment_jobs')
    .insert({
      tenant_id: ctx.tenantId,
      job_type: 'batch',
      trigger_reason: 'manual',
      status: 'running',
      subscriber_ids: ids,
      total_count: ids.length,
      started_at: new Date().toISOString(),
    })
    .select('id').single()
  if (jobErr || !job) return NextResponse.json({ error: 'job create failed', detail: jobErr?.message }, { status: 500 })

  const jobId = (job as unknown as { id: string }).id
  const messages: EnrichmentJobMsg[] = ids.map(id => ({ subscriberId: id, tenantId: ctx.tenantId!, jobId }))
  await enqueue(db as unknown as RpcClient, QUEUES.enrichment, messages)

  console.log('[enrichment/enqueue] tenant=%s job=%s enqueued=%d', ctx.tenantId, jobId, ids.length)
  return NextResponse.json({ ok: true, jobId, enqueued: ids.length })
}
