import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { serviceClient } from '@/lib/enrichment/worker-io'
import { signLinkToken } from '@/lib/verification/link-token'

// POST /api/verification/invite — owner/admin mints a signed hosted-flow link for a subscriber (Part 6.1).
// Returns the URL to send. (The email-loop issue path, #2, will call this same signer to send the link;
// this route lets the link be generated/tested without sending anything.)
// Body: { subscriberId, ttlDays? }.

export const dynamic = 'force-dynamic'

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

export async function POST(req: NextRequest) {
  const ctx = await getCtx()
  if (!ctx?.tenantId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!['owner', 'admin'].includes(ctx.role ?? ''))
    return NextResponse.json({ error: 'Owner or admin role required' }, { status: 403 })

  const body = await req.json().catch(() => null)
  const subscriberId = typeof body?.subscriberId === 'string' ? body.subscriberId : ''
  const ttlDays = Number.isFinite(body?.ttlDays) ? Math.min(60, Math.max(1, body.ttlDays)) : 14
  if (!subscriberId) return NextResponse.json({ error: 'subscriberId required' }, { status: 400 })

  // The subscriber must belong to the caller's tenant.
  const db = serviceClient()
  const { data: sub } = await db
    .from('subscribers').select('id').eq('id', subscriberId).eq('tenant_id', ctx.tenantId).is('deleted_at', null).maybeSingle()
  if (!sub) return NextResponse.json({ error: 'subscriber not found in tenant' }, { status: 404 })

  const token = signLinkToken(subscriberId, ctx.tenantId, { ttlSeconds: ttlDays * 24 * 60 * 60 })
  // Base URL: verify.lycert.com in production once DNS is configured (Phase 2 Step 6); the request origin
  // works on staging/preview today.
  const base = process.env.LYCERT_VERIFY_BASE_URL || req.nextUrl.origin
  const url = `${base.replace(/\/$/, '')}/verify/${token}`
  return NextResponse.json({ ok: true, url, token, expiresInDays: ttlDays })
}
