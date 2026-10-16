import { type NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const maxDuration = 60

/**
 * Given a list of candidate emails, return which already exist (live, non-archived) for the caller's
 * tenant. The import preview uses this to show how many rows will UPDATE an existing subscriber vs
 * create a new one (the importer upserts on tenant_id+email, so overlapping rows never duplicate).
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient()

  const { data: authData } = await supabase.auth.getUser()
  if (!authData.user) return NextResponse.json({ existing: [] }, { status: 401 })

  const { data: tenantUser } = (await supabase
    .from('tenant_users')
    .select('tenant_id')
    .eq('user_id', authData.user.id)
    .maybeSingle()) as unknown as { data: { tenant_id: string } | null }
  if (!tenantUser) return NextResponse.json({ existing: [] }, { status: 403 })

  let body: { emails?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const emails = Array.isArray(body.emails)
    ? Array.from(new Set(body.emails
        .filter((e): e is string => typeof e === 'string')
        .map(e => e.toLowerCase().trim())
        .filter(Boolean)))
    : []
  if (!emails.length) return NextResponse.json({ existing: [] })

  // Match the importer's key exactly: lowercased email, scoped to tenant, live rows only.
  const { data, error } = (await supabase
    .from('subscribers')
    .select('email, name')
    .eq('tenant_id', tenantUser.tenant_id)
    .is('deleted_at', null)
    .in('email', emails)) as unknown as { data: { email: string; name: string | null }[] | null; error: unknown }

  if (error) return NextResponse.json({ existing: [] }, { status: 500 })
  return NextResponse.json({ existing: data ?? [] })
}
