import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { buildAuthorizeUrl } from '@/lib/crm/hubspot-client'
import { signOAuthState } from '@/lib/crm/oauth-state'

// GET /api/crm/hubspot/oauth/authorize — "Connect HubSpot" (Bridge Part 6.3 step 1-2).
// Private-distribution scopes only (Part 6.2); no sensitive/highly-sensitive scopes requested.
export const dynamic = 'force-dynamic'

const SCOPES = [
  'oauth',
  'crm.objects.contacts.read',
  'crm.objects.contacts.write',
  'crm.schemas.contacts.read',
  'crm.schemas.contacts.write',
  'automation',
]

async function getCtx() {
  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return null
  try {
    const p = JSON.parse(Buffer.from(session.access_token.split('.')[1], 'base64').toString())
    return { tenantId: (p.tenant_id as string | undefined) ?? null, role: (p.user_role as string | undefined) ?? (p.role as string | undefined) }
  } catch { return null }
}

export async function GET(req: NextRequest) {
  const ctx = await getCtx()
  if (!ctx?.tenantId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!['owner', 'admin'].includes(ctx.role ?? '')) return NextResponse.json({ error: 'Owner or admin role required' }, { status: 403 })

  const clientId = process.env.LYCERT_HUBSPOT_CLIENT_ID
  if (!clientId) return NextResponse.json({ error: 'HubSpot is not configured yet' }, { status: 503 })

  const redirectUri = new URL('/api/crm/hubspot/oauth/callback', req.nextUrl.origin).toString()
  const state = signOAuthState(ctx.tenantId)
  const url = buildAuthorizeUrl({ clientId, redirectUri, scopes: SCOPES, state })
  return NextResponse.redirect(url)
}
