import { type NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export const maxDuration = 60

/** Restore archived (soft-deleted) subscribers. Owner/admin only; audited. */
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
    return NextResponse.json({ error: 'Only owners and admins can restore subscribers.' }, { status: 403 })
  }

  let body: { ids?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : []
  if (!ids.length) {
    return NextResponse.json({ error: 'No subscriber ids provided.' }, { status: 400 })
  }

  const serviceDb = createServiceClient(
    process.env.NEXT_PUBLIC_LYCERT_SUPABASE_URL!,
    process.env.LYCERT_SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { data, error } = (await serviceDb
    .from('subscribers')
    .update({ deleted_at: null, deleted_by: null } as never)
    .eq('tenant_id', tenantUser.tenant_id)
    .in('id', ids)
    .not('deleted_at', 'is', null)
    .select('id')) as unknown as { data: { id: string }[] | null; error: { message: string } | null }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const affectedIds = (data ?? []).map(r => r.id)

  if (affectedIds.length) {
    await (serviceDb.from('audit_logs') as never as {
      insert: (v: Record<string, unknown>) => Promise<unknown>
    }).insert({
      tenant_id: tenantUser.tenant_id,
      actor_type: 'user',
      actor_id: authData.user.id,
      action: 'subscriber.restored',
      resource_type: 'subscriber',
      metadata: { count: affectedIds.length, subscriber_ids: affectedIds },
    })
  }

  return NextResponse.json({ affected: affectedIds.length })
}
