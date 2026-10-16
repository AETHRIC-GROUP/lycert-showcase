import { type NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { computeLifecycleStage } from '@/lib/utils/lifecycle'

// 5-minute limit per batch on Vercel Pro — safe for 200-row upserts
export const maxDuration = 300

interface ImportRow {
  email: string
  name: string
  stated_graduation_date: string
  institution_name?: string
  institution_location?: string
  account_country?: string
  account_name?: string
  external_id?: string
  plan_name?: string
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()

  const { data: authData } = await supabase.auth.getUser()
  if (!authData.user) {
    return NextResponse.json({ imported: 0, error: 'Not authenticated' }, { status: 401 })
  }

  const { data: tenantUser } = (await supabase
    .from('tenant_users')
    .select('tenant_id')
    .eq('user_id', authData.user.id)
    .maybeSingle()) as unknown as { data: { tenant_id: string } | null }

  if (!tenantUser) {
    return NextResponse.json({ imported: 0, error: 'No tenant account found for this user.' }, { status: 403 })
  }

  let rows: ImportRow[]
  try {
    rows = await req.json()
  } catch {
    return NextResponse.json({ imported: 0, error: 'Invalid request body' }, { status: 400 })
  }

  const records = rows.map(row => ({
    tenant_id: tenantUser.tenant_id,
    email: row.email.toLowerCase().trim(),
    name: row.name.trim() || null,
    stated_graduation_date: row.stated_graduation_date || null,
    institution_name: row.institution_name?.trim() || null,
    institution_location: row.institution_location?.trim() || null,
    account_country: row.account_country?.trim() || null,
    account_name: row.account_name?.trim() || null,
    external_id: row.external_id?.trim() || null,
    plan_name: row.plan_name?.trim() || null,
    plan_type: 'edu' as const,
    lifecycle_stage: computeLifecycleStage(row.stated_graduation_date),
  }))

  const { data, error } = (await supabase
    .from('subscribers')
    .upsert(records as unknown as never[], { onConflict: 'tenant_id,email', ignoreDuplicates: false })
    .select('id')) as unknown as { data: { id: string }[] | null; error: { message: string } | null }

  if (error) {
    return NextResponse.json({ imported: 0, error: error.message }, { status: 500 })
  }

  const imported = data?.length ?? 0

  if (imported > 0) {
    await (supabase.from('audit_logs') as any).insert({
      tenant_id: tenantUser.tenant_id,
      actor_type: 'user',
      action: 'subscriber.batch_imported',
      resource_type: 'subscriber_import',
      metadata: { count: imported, batch_size: rows.length },
    })

    // Fire pre-enrichment for all imported subscribers (free APIs, background task).
    // School Cleaner, Location Cleaner, email domain classification run automatically.
    // Fire-and-forget — import response returns immediately.
    const importedIds = (data ?? []).map((r: { id: string }) => r.id)
    const apiUrl = process.env.NEXT_PUBLIC_LYCERT_API_URL
    if (apiUrl) {
      const { data: { session } } = await supabase.auth.getSession()
      if (session) {
        fetch(`${apiUrl}/api/v1/tenants/${tenantUser.tenant_id}/pre-enrich/batch`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ subscriber_ids: importedIds }),
        }).catch(() => { /* errors logged server-side */ })
      }
    }
  }

  return NextResponse.json({ imported })
}
