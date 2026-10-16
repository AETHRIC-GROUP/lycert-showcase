import { type NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export const maxDuration = 60

type Mode = 'archive' | 'purge'

/**
 * Delete subscribers — soft (archive, recoverable) or hard (purge, GDPR right-to-erasure).
 * Restricted to owner/admin. Every action is written to audit_logs. Purge is a plain DELETE; all
 * dependent rows (scores, cases, enrichment) are ON DELETE CASCADE, so they are removed with it.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient()

  const { data: authData } = await supabase.auth.getUser()
  if (!authData.user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const { data: tenantUser } = (await supabase
    .from('tenant_users')
    .select('role, tenant_id')
    .eq('user_id', authData.user.id)
    .maybeSingle()) as unknown as { data: { role: string; tenant_id: string } | null }

  if (!tenantUser) {
    return NextResponse.json({ error: 'No tenant account found for this user.' }, { status: 403 })
  }
  if (tenantUser.role !== 'owner' && tenantUser.role !== 'admin') {
    return NextResponse.json({ error: 'Only owners and admins can delete subscribers.' }, { status: 403 })
  }

  let body: { ids?: unknown; mode?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : []
  const mode: Mode = body.mode === 'purge' ? 'purge' : 'archive'
  if (!ids.length) {
    return NextResponse.json({ error: 'No subscriber ids provided.' }, { status: 400 })
  }

  const serviceDb = createServiceClient(
    process.env.NEXT_PUBLIC_LYCERT_SUPABASE_URL!,
    process.env.LYCERT_SUPABASE_SERVICE_ROLE_KEY!,
  )

  // Scope to this tenant so a caller can never touch another tenant's data even by guessing ids.
  let affectedIds: string[] = []
  if (mode === 'purge') {
    const { data, error } = (await serviceDb
      .from('subscribers')
      .delete()
      .eq('tenant_id', tenantUser.tenant_id)
      .in('id', ids)
      .select('id')) as unknown as { data: { id: string }[] | null; error: { message: string } | null }
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    affectedIds = (data ?? []).map(r => r.id)
  } else {
    const { data, error } = (await serviceDb
      .from('subscribers')
      .update({ deleted_at: new Date().toISOString(), deleted_by: authData.user.id } as never)
      .eq('tenant_id', tenantUser.tenant_id)
      .in('id', ids)
      .is('deleted_at', null) // don't re-stamp already-archived rows
      .select('id')) as unknown as { data: { id: string }[] | null; error: { message: string } | null }
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    affectedIds = (data ?? []).map(r => r.id)
  }

  if (affectedIds.length) {
    await (serviceDb.from('audit_logs') as never as {
      insert: (v: Record<string, unknown>) => Promise<unknown>
    }).insert({
      tenant_id: tenantUser.tenant_id,
      actor_type: 'user',
      actor_id: authData.user.id,
      action: mode === 'purge' ? 'subscriber.purged' : 'subscriber.archived',
      resource_type: 'subscriber',
      metadata: { count: affectedIds.length, mode, subscriber_ids: affectedIds },
    })
  }

  return NextResponse.json({ affected: affectedIds.length, mode })
}
