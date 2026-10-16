import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '@/lib/enrichment/worker-io'
import { verifyLinkToken } from '@/lib/verification/link-token'
import { consentFields, CONSENT_TEXT_VERSION } from '@/lib/verification/consent-text'

// POST /api/verification/consent — records the subscriber's FERPA consent from the hosted flow (Part 6.1).
// Body: { token, fullName, agreed }. The token identifies the subscriber+tenant (signed, not trusted from
// the client). Storing consent does NOT run any provider — a requires_consent check only ever runs later
// via the orchestrator, and only once that provider is enabled + the consent text is legally approved.

export const dynamic = 'force-dynamic'

type Row = Record<string, unknown>

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const token = typeof body?.token === 'string' ? body.token : ''
  const fullName = typeof body?.fullName === 'string' ? body.fullName.trim() : ''
  const agreed = body?.agreed === true

  const v = verifyLinkToken(token)
  if (!v.valid) return NextResponse.json({ error: `invalid link (${v.reason})` }, { status: 400 })
  if (!agreed) return NextResponse.json({ error: 'You must check the authorization box.' }, { status: 400 })
  if (fullName.length < 2) return NextResponse.json({ error: 'Please type your full name as your signature.' }, { status: 400 })

  const { sub: subscriberId, ten: tenantId, exp } = v.payload
  const db = serviceClient()

  // Confirm the subscriber still belongs to the tenant (and isn't soft-deleted).
  const { data: subRow } = await db
    .from('subscribers').select('id, tenant_id')
    .eq('id', subscriberId).eq('tenant_id', tenantId).is('deleted_at', null).maybeSingle()
  if (!subRow) return NextResponse.json({ error: 'subscriber not found' }, { status: 404 })

  const { data: tenantRow } = await db.from('tenants').select('name').eq('id', tenantId).maybeSingle()
  const clientName = ((tenantRow as Row | null)?.name as string) ?? 'your software provider'
  const fields = consentFields({ clientName })

  // Consent expires with the link window (re-consent on the next re-verification cycle).
  const expiresAt = new Date(exp * 1000).toISOString()
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || null

  const { error } = await db.from('verification_consents').insert({
    tenant_id: tenantId,
    subscriber_id: subscriberId,
    scope: fields.scope,
    purpose: fields.purpose,
    recipient: fields.recipient,
    consent_text_version: CONSENT_TEXT_VERSION,
    granted_at: new Date().toISOString(),
    granted_via: 'hosted_verification_flow',
    ip_address: ip,
    expires_at: expiresAt,
  })
  if (error) return NextResponse.json({ error: 'could not record consent', detail: error.message }, { status: 500 })

  console.log('[verification/consent] recorded sub=%s tenant=%s version=%s', subscriberId, tenantId, CONSENT_TEXT_VERSION)
  return NextResponse.json({ ok: true })
}
