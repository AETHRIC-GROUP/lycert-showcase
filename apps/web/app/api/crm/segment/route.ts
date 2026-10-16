import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { serviceClient } from '@/lib/enrichment/worker-io'
import { enqueue } from '@/lib/enrichment/queue'
import { CRM_QUEUES } from '@/lib/crm/worker-io'
import { DEFAULT_INBOUND_MAPPING } from '@/lib/crm/backfill'

// POST /api/crm/segment — Bridge Part 6.5, M1 property mode only: the onboarding wizard's "define the
// EDU segment" step. Saves crm_segment_config, seeds the default inbound mapping (overridable later via
// crm_property_mappings), then starts the backfill+write-back run.
// Body: { property: string, value: string }
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

export async function POST(req: NextRequest) {
  const ctx = await getCtx()
  if (!ctx?.tenantId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!['owner', 'admin'].includes(ctx.role ?? '')) return NextResponse.json({ error: 'Owner or admin role required' }, { status: 403 })

  const body = await req.json().catch(() => null)
  const property = typeof body?.property === 'string' ? body.property.trim() : ''
  const value = typeof body?.value === 'string' ? body.value.trim() : ''
  if (!property || !value) return NextResponse.json({ error: 'property and value are required' }, { status: 400 })

  const db = serviceClient()

  const { data: connection } = await db.from('crm_connections')
    .select('id').eq('tenant_id', ctx.tenantId).eq('provider', 'hubspot').eq('status', 'connected').maybeSingle()
  if (!connection) return NextResponse.json({ error: 'Connect HubSpot before configuring the EDU segment' }, { status: 409 })

  const { error: segErr } = await db.from('crm_segment_config').upsert({
    tenant_id: ctx.tenantId, provider: 'hubspot', mode: 'property', definition: { property, value },
  }, { onConflict: 'tenant_id,provider' })
  if (segErr) return NextResponse.json({ error: 'save failed', detail: segErr.message }, { status: 500 })

  // Seed the default inbound mapping if the tenant has none yet (first-time setup only — never
  // overwrites a mapping an admin already customized).
  const { data: existingInbound } = await db.from('crm_property_mappings')
    .select('lycert_field').eq('tenant_id', ctx.tenantId).eq('provider', 'hubspot').eq('direction', 'inbound')
  if (!existingInbound || existingInbound.length === 0) {
    const rows = Object.entries(DEFAULT_INBOUND_MAPPING).map(([lycert_field, crm_property]) => ({
      tenant_id: ctx.tenantId, provider: 'hubspot', direction: 'inbound',
      lycert_field, crm_property, created_by_lycert: true, status: 'ok',
    }))
    const { error: mapErr } = await db.from('crm_property_mappings').insert(rows)
    if (mapErr) return NextResponse.json({ error: 'mapping seed failed', detail: mapErr.message }, { status: 500 })
  }

  const { data: run, error: runErr } = await db.from('crm_sync_runs')
    .insert({ tenant_id: ctx.tenantId, provider: 'hubspot', kind: 'backfill', status: 'running' })
    .select('id').single()
  if (runErr) return NextResponse.json({ error: 'run start failed', detail: runErr.message }, { status: 500 })

  await enqueue(db as never, CRM_QUEUES.crmSync, [
    { tenantId: ctx.tenantId, kind: 'backfill_page', runId: (run as { id: string }).id, after: null },
  ])

  await db.from('audit_logs').insert({
    tenant_id: ctx.tenantId, actor_id: ctx.userId, actor_type: 'user',
    action: 'crm.hubspot.segment_configured', resource_type: 'crm_segment_config', resource_id: null,
    metadata: { property, value },
  })

  return NextResponse.json({ ok: true, runId: (run as { id: string }).id })
}
