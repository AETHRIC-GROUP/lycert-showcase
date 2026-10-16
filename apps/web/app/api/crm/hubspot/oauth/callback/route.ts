import { NextRequest, NextResponse } from 'next/server'
import { exchangeCodeForToken } from '@/lib/crm/hubspot-client'
import { verifyOAuthState } from '@/lib/crm/oauth-state'
import { encryptCredential } from '@/lib/crypto'
import { serviceClient } from '@/lib/enrichment/worker-io'
import { enqueue } from '@/lib/enrichment/queue'
import { CRM_QUEUES } from '@/lib/crm/worker-io'

// GET /api/crm/hubspot/oauth/callback — Bridge Part 6.3 steps 3-6: exchange code -> store crm_connections
// (encrypted) -> immediately enqueue bootstrap. No tenant session needed here (HubSpot redirects the
// browser here directly); the signed `state` param is the only tenant binding, verified timing-safe.
export const dynamic = 'force-dynamic'

const SCOPES_RECORDED = [
  'oauth', 'crm.objects.contacts.read', 'crm.objects.contacts.write',
  'crm.schemas.contacts.read', 'crm.schemas.contacts.write', 'automation',
]

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code')
  const state = req.nextUrl.searchParams.get('state') ?? ''
  const settingsUrl = new URL('/dashboard/settings/integrations', req.nextUrl.origin)

  const verified = verifyOAuthState(state)
  if (!verified.valid) {
    settingsUrl.searchParams.set('hubspot_error', verified.reason)
    return NextResponse.redirect(settingsUrl)
  }
  if (!code) {
    settingsUrl.searchParams.set('hubspot_error', 'missing_code')
    return NextResponse.redirect(settingsUrl)
  }

  const clientId = process.env.LYCERT_HUBSPOT_CLIENT_ID
  const clientSecret = process.env.LYCERT_HUBSPOT_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    settingsUrl.searchParams.set('hubspot_error', 'not_configured')
    return NextResponse.redirect(settingsUrl)
  }

  const redirectUri = new URL('/api/crm/hubspot/oauth/callback', req.nextUrl.origin).toString()
  const tenantId = verified.payload.ten

  try {
    const token = await exchangeCodeForToken({ clientId, clientSecret, redirectUri, code })

    // portalId via the simplest stable account-info call (no domain field available here — left null;
    // not required for M1 logic, informational only).
    let portalId = ''
    try {
      const meResp = await fetch('https://api.hubapi.com/integrations/v1/me', {
        headers: { Authorization: `Bearer ${token.accessToken}` },
      })
      if (meResp.ok) portalId = String((await meResp.json()).portalId ?? '')
    } catch { /* non-fatal — portalId is informational */ }

    const db = serviceClient()
    const accessExpiresAt = new Date(Date.now() + token.expiresIn * 1000).toISOString()
    const { error } = await db.from('crm_connections').upsert({
      tenant_id: tenantId, provider: 'hubspot', portal_id: portalId || 'unknown',
      scopes: SCOPES_RECORDED,
      access_token_enc: encryptCredential(token.accessToken),
      access_expires_at: accessExpiresAt,
      refresh_token_enc: encryptCredential(token.refreshToken),
      status: 'connected', last_error: null, installed_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id,provider' })
    if (error) throw new Error(error.message)

    await db.from('audit_logs').insert({
      tenant_id: tenantId, actor_type: 'system', action: 'crm.hubspot.connected',
      resource_type: 'crm_connection', resource_id: null, metadata: { portal_id: portalId || null },
    })

    // Immediately enqueue property bootstrap (Bridge 6.3 step 6) — backfill waits for segment config
    // (the segment-config save route starts that separately-tracked run).
    await enqueue(db as never, CRM_QUEUES.crmSync, [{ tenantId, kind: 'bootstrap' }])

    settingsUrl.searchParams.set('hubspot_connected', '1')
    return NextResponse.redirect(settingsUrl)
  } catch (e) {
    console.error('[crm/hubspot/callback] error', e)
    settingsUrl.searchParams.set('hubspot_error', 'exchange_failed')
    return NextResponse.redirect(settingsUrl)
  }
}
