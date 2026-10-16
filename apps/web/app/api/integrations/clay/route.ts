import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { encryptCredential } from '@/lib/crypto'

function serviceDb() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_LYCERT_SUPABASE_URL!,
    process.env.LYCERT_SUPABASE_SERVICE_ROLE_KEY!,
  )
}

async function getAuthContext() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const jwt = (await supabase.auth.getSession()).data.session?.access_token
  if (!jwt) return null
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString())
    return { userId: user.id, tenantId: payload.tenant_id as string | undefined, role: payload.role as string | undefined }
  } catch { return null }
}

/** GET — returns integration status (never the raw key) */
export async function GET() {
  const ctx = await getAuthContext()
  if (!ctx?.tenantId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { data } = await serviceDb()
    .from('integrations')
    .select('status, last_sync_at, error_message, updated_at')
    .eq('tenant_id', ctx.tenantId)
    .eq('integration_type', 'clay')
    .maybeSingle()

  return NextResponse.json({ integration: data ?? null })
}

/** POST — save (or update) Clay API key */
export async function POST(req: NextRequest) {
  const ctx = await getAuthContext()
  if (!ctx?.tenantId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!['owner', 'admin'].includes(ctx.role ?? ''))
    return NextResponse.json({ error: 'Owner or admin role required' }, { status: 403 })

  const body = await req.json()
  const apiKey = (body.api_key as string | undefined)?.trim()
  if (!apiKey) return NextResponse.json({ error: 'api_key is required' }, { status: 400 })

  let encrypted: string
  try {
    encrypted = encryptCredential(apiKey)
  } catch {
    return NextResponse.json({ error: 'Encryption key not configured on server' }, { status: 500 })
  }

  const db = serviceDb()
  const { error } = await db.from('integrations').upsert(
    {
      tenant_id: ctx.tenantId,
      integration_type: 'clay',
      status: 'connected',
      credentials_encrypted: encrypted,
      error_message: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'tenant_id,integration_type' },
  )

  if (error) return NextResponse.json({ error: 'Failed to save integration' }, { status: 500 })
  return NextResponse.json({ ok: true })
}

/** DELETE — disconnect Clay */
export async function DELETE() {
  const ctx = await getAuthContext()
  if (!ctx?.tenantId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!['owner', 'admin'].includes(ctx.role ?? ''))
    return NextResponse.json({ error: 'Owner or admin role required' }, { status: 403 })

  await serviceDb()
    .from('integrations')
    .update({ status: 'disconnected', credentials_encrypted: null, updated_at: new Date().toISOString() })
    .eq('tenant_id', ctx.tenantId)
    .eq('integration_type', 'clay')

  return NextResponse.json({ ok: true })
}
