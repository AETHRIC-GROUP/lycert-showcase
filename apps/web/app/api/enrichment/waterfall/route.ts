import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'

// PUT    /api/enrichment/waterfall  → save this tenant's cascade order/enable (owner/admin)
// DELETE /api/enrichment/waterfall  → reset to the Lycert default (delete tenant overrides)
//
// The write is delete-all-then-insert for the tenant. tenant_waterfall_config has a
// UNIQUE(tenant_id, position) constraint, so updating rows one-by-one would transiently
// duplicate a position and be rejected. Clearing first sidesteps the collision.

function serviceDb() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_LYCERT_SUPABASE_URL!,
    process.env.LYCERT_SUPABASE_SERVICE_ROLE_KEY!,
  )
}

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

type OrderItem = { providerKey: string; position: number; enabled: boolean }

export async function PUT(req: NextRequest) {
  const ctx = await getCtx()
  if (!ctx?.tenantId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!['owner', 'admin'].includes(ctx.role ?? ''))
    return NextResponse.json({ error: 'Owner or admin role required' }, { status: 403 })

  const body = await req.json().catch(() => null)
  const order = body?.order as OrderItem[] | undefined
  if (!Array.isArray(order) || order.length === 0)
    return NextResponse.json({ error: 'order array is required' }, { status: 400 })

  // Reject duplicate positions / keys up front (clearer than a DB constraint error).
  const positions = new Set<number>()
  const keys = new Set<string>()
  for (const item of order) {
    if (typeof item.position !== 'number' || !item.providerKey)
      return NextResponse.json({ error: 'each item needs providerKey + numeric position' }, { status: 400 })
    if (positions.has(item.position) || keys.has(item.providerKey))
      return NextResponse.json({ error: 'duplicate position or providerKey' }, { status: 400 })
    positions.add(item.position)
    keys.add(item.providerKey)
  }

  const db = serviceDb()
  const { error: delErr } = await db.from('tenant_waterfall_config').delete().eq('tenant_id', ctx.tenantId)
  if (delErr) return NextResponse.json({ error: 'reset failed', detail: delErr.message }, { status: 500 })

  const rows = order.map(o => ({
    tenant_id: ctx.tenantId,
    provider_key: o.providerKey,
    position: o.position,
    enabled: o.enabled !== false,
  }))
  const { error: insErr } = await db.from('tenant_waterfall_config').insert(rows)
  if (insErr) return NextResponse.json({ error: 'save failed', detail: insErr.message }, { status: 500 })

  console.log('[enrichment/waterfall] saved tenant=%s providers=%d', ctx.tenantId, rows.length)
  return NextResponse.json({ ok: true, saved: rows.length })
}

export async function DELETE() {
  const ctx = await getCtx()
  if (!ctx?.tenantId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!['owner', 'admin'].includes(ctx.role ?? ''))
    return NextResponse.json({ error: 'Owner or admin role required' }, { status: 403 })

  const { error } = await serviceDb().from('tenant_waterfall_config').delete().eq('tenant_id', ctx.tenantId)
  if (error) return NextResponse.json({ error: 'reset failed', detail: error.message }, { status: 500 })

  console.log('[enrichment/waterfall] reset to default tenant=%s', ctx.tenantId)
  return NextResponse.json({ ok: true, reset: true })
}
