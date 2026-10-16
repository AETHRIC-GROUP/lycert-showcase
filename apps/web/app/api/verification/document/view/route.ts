import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { serviceClient } from '@/lib/enrichment/worker-io'

// POST /api/verification/document/view — mint a time-boxed signed URL so the assigned reviewer can SEE the
// raw document during the processing window (LYCERT_DOCUMENT_REVIEW_ARCHITECTURE.md Part 7). Owner/admin
// only; refuses once the file is purged or the decision is made; every view writes an audit_log entry
// (Part 5.4). The URL expires on its own — it is never a durable link.

export const dynamic = 'force-dynamic'
type Row = Record<string, unknown>
const SIGNED_URL_TTL_SECONDS = 10 * 60

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
  const documentId = typeof body?.documentId === 'string' ? body.documentId : ''
  if (!documentId) return NextResponse.json({ error: 'documentId required' }, { status: 400 })

  const db = serviceClient()
  const { data: doc } = await db
    .from('verification_documents')
    .select('id, tenant_id, transient_storage_ref, purged_at, review_status')
    .eq('id', documentId).eq('tenant_id', ctx.tenantId).maybeSingle()
  if (!doc) return NextResponse.json({ error: 'document not found' }, { status: 404 })
  const d = doc as unknown as Row

  // Viewing window closes with the decision or the purge (Part 7): no ref, purged, or decided → gone.
  if (!d.transient_storage_ref || d.purged_at || d.review_status === 'decided') {
    return NextResponse.json({ error: 'raw document no longer available (purged per process-and-purge)' }, { status: 410 })
  }

  const signed = await db.storage
    .from('verification-documents')
    .createSignedUrl(String(d.transient_storage_ref), SIGNED_URL_TTL_SECONDS)
  if (signed.error || !signed.data?.signedUrl) {
    return NextResponse.json({ error: 'signing failed', detail: signed.error?.message }, { status: 500 })
  }

  await db.from('audit_logs').insert({
    tenant_id: ctx.tenantId, actor_id: ctx.userId, actor_type: 'user', action: 'verification_document.viewed',
    resource_type: 'verification_document', resource_id: documentId, metadata: { ttl_seconds: SIGNED_URL_TTL_SECONDS },
  })

  return NextResponse.json({ ok: true, url: signed.data.signedUrl, expiresInSeconds: SIGNED_URL_TTL_SECONDS })
}
