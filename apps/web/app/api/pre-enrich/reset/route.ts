import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { serviceClient } from '@/lib/enrichment/worker-io'

// POST /api/pre-enrich/reset — owner/admin "re-run pre-enrichment" affordance (NEXT_STEPS 2026-06-20).
// The Pre-Enrich batch route only touches `email_domain_type IS NULL` rows, so a row classified before
// a fix or an academic_domains seed refresh was never re-evaluated (the Student B class — fixed by
// hand that session). This resets the derived pre-enrichment columns to NULL for the selected rows so
// the next Pre-Enrich All re-derives them. Source-of-truth columns (email, institution_name, dates) are
// never touched. Body: { subscriberIds: string[] }.

export const dynamic = 'force-dynamic'

const RESET_PATCH = {
  email_domain_type: null,
  institution_name_normalized: null,
  institution_domain_verified: null,
  institution_country_normalized: null,
  account_country_normalized: null,
  enrichment_priority: null,
} as const

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
  const ids = Array.isArray(body?.subscriberIds) ? (body.subscriberIds as string[]).filter(v => typeof v === 'string') : []
  if (!ids.length) return NextResponse.json({ error: 'subscriberIds required' }, { status: 400 })

  const db = serviceClient()
  const { data, error } = await db
    .from('subscribers')
    .update(RESET_PATCH)
    .eq('tenant_id', ctx.tenantId)
    .is('deleted_at', null)
    .in('id', ids)
    .select('id')
  if (error) return NextResponse.json({ error: 'reset failed', detail: error.message }, { status: 500 })
  const affected = (data ?? []).length

  await db.from('audit_logs').insert({
    tenant_id: ctx.tenantId, actor_id: ctx.userId, actor_type: 'user',
    action: 'subscriber.pre_enrichment_reset', resource_type: 'subscriber', resource_id: null,
    metadata: { count: affected, subscriber_ids: ids.slice(0, 100) },
  })

  console.log('[pre-enrich/reset] tenant=%s reset=%d', ctx.tenantId, affected)
  return NextResponse.json({ ok: true, affected })
}
