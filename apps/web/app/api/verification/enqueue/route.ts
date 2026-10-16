import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { serviceClient } from '@/lib/enrichment/worker-io'
import { enqueue, type RpcClient } from '@/lib/enrichment/queue'
import { VERIFICATION_QUEUES } from '@/lib/verification/worker-io'
import type { VerificationJobMsg } from '@/lib/verification/worker'

// POST /api/verification/enqueue — owner/admin trigger that pushes one verification_q message per
// subscriber. The durable worker (pg_cron → /api/verification/worker) runs the waterfall in bounded
// chunks; this handler only enqueues and returns (jobs never run inside a request — Part 9.1.3).
//
// Body: { subscriberIds?: string[] }. Omitted → every active subscriber for the tenant.

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
  let query = db.from('subscribers').select('id').eq('tenant_id', ctx.tenantId).is('deleted_at', null)
  if (explicitIds) query = query.in('id', explicitIds)
  const { data, error } = await query
  if (error) return NextResponse.json({ error: 'lookup failed', detail: error.message }, { status: 500 })

  const ids = ((data ?? []) as unknown as Array<{ id: string }>).map(r => r.id)
  if (ids.length === 0) return NextResponse.json({ ok: true, enqueued: 0 })

  const messages: VerificationJobMsg[] = ids.map(id => ({ subscriberId: id, tenantId: ctx.tenantId! }))
  await enqueue(db as unknown as RpcClient, VERIFICATION_QUEUES.verification, messages)

  console.log('[verification/enqueue] tenant=%s enqueued=%d', ctx.tenantId, ids.length)
  return NextResponse.json({ ok: true, enqueued: ids.length })
}
