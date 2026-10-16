import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { serviceClient } from '@/lib/enrichment/worker-io'

// POST /api/crm/hubspot/disconnect — Bridge Part 6.3 step 7: mark disconnected, stop jobs for the
// tenant (in-flight queue messages fail cleanly at getConnection once status != 'connected'/'error'),
// keep the mirror data per DPA retention (no row deletion here).
export const dynamic = 'force-dynamic'

async function getCtx() {
  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return null
  try {
    const p = JSON.parse(Buffer.from(session.access_token.split('.')[1], 'base64').toString())
    return { userId: (p.sub as string | undefined) ?? null, tenantId: (p.tenant_id as string | undefined) ?? null, role: (p.user_role as string | undefined) ?? (p.role as string | undefined) }
  } catch { return null }
}

export async function POST() {
  const ctx = await getCtx()
  if (!ctx?.tenantId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!['owner', 'admin'].includes(ctx.role ?? '')) return NextResponse.json({ error: 'Owner or admin role required' }, { status: 403 })

  const db = serviceClient()
  const { error } = await db.from('crm_connections')
    .update({ status: 'disconnected' })
    .eq('tenant_id', ctx.tenantId).eq('provider', 'hubspot')
  if (error) return NextResponse.json({ error: 'disconnect failed', detail: error.message }, { status: 500 })

  await db.from('audit_logs').insert({
    tenant_id: ctx.tenantId, actor_id: ctx.userId, actor_type: 'user',
    action: 'crm.hubspot.disconnected', resource_type: 'crm_connection', resource_id: null, metadata: {},
  })

  return NextResponse.json({ ok: true })
}
