import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { serviceClient } from '@/lib/enrichment/worker-io'

// POST /api/verification/document/review — owner/admin human-in-the-loop decision on a document (Stage F).
// Body: { documentId, decision: 'approved'|'rejected'|'needs_more', note }. A human ALWAYS decides — the
// machine only recommends. On a verdict: stamp the decision, set storage_delete_at=now() so the purge
// worker destroys the raw file on its next sweep (process-and-purge), and on 'approved' write a MEDIUM-
// confidence verification_results row. A 'rejected'/tamper decision NEVER auto-actions — it can only ever
// produce UNABLE_TO_CONFIRM via the waterfall (a document can't refute enrollment); any adverse step still
// goes through the human notice + appeal gate elsewhere.

export const dynamic = 'force-dynamic'
type Row = Record<string, unknown>
const DECISIONS = new Set(['approved', 'rejected', 'needs_more'])
const RESULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

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
  const decision = typeof body?.decision === 'string' ? body.decision : ''
  const note = typeof body?.note === 'string' ? body.note.trim() : ''
  if (!documentId || !DECISIONS.has(decision)) return NextResponse.json({ error: 'documentId + valid decision required' }, { status: 400 })
  if (!note) return NextResponse.json({ error: 'A decision note is required' }, { status: 400 })

  const db = serviceClient()
  const { data: doc } = await db
    .from('verification_documents')
    .select('id, tenant_id, subscriber_id')
    .eq('id', documentId).eq('tenant_id', ctx.tenantId).maybeSingle()
  if (!doc) return NextResponse.json({ error: 'document not found' }, { status: 404 })
  const d = doc as unknown as Row
  const now = new Date()

  // Record the decision + trigger purge of the raw file (verdict reached → destroy on next sweep).
  const finalDecision = decision === 'needs_more' ? null : decision
  const reviewStatus = decision === 'needs_more' ? 'pending_review' : 'decided'
  const { error: updErr } = await db.from('verification_documents').update({
    reviewer_id: ctx.userId, reviewer_decision: finalDecision ?? 'needs_more',
    reviewer_decided_at: now.toISOString(), review_status: reviewStatus,
    ...(decision !== 'needs_more' ? { storage_delete_at: now.toISOString() } : {}),
  }).eq('id', documentId)
  if (updErr) return NextResponse.json({ error: 'update failed', detail: updErr.message }, { status: 500 })

  // On approve, write the MEDIUM-confidence enrollment result (the waterfall reads this).
  if (decision === 'approved') {
    await db.from('verification_results').insert({
      tenant_id: d.tenant_id, subscriber_id: d.subscriber_id, provider_key: 'document', method_class: 'document',
      status: 'enrolled', confidence: 'medium', as_of_date: now.toISOString().slice(0, 10),
      raw_reference: documentId, checked_at: now.toISOString(),
      delete_at: new Date(now.getTime() + RESULT_RETENTION_MS).toISOString(),
    })
  }

  await db.from('audit_logs').insert({
    tenant_id: d.tenant_id, actor_id: ctx.userId, actor_type: 'user', action: 'verification_document.reviewed',
    resource_type: 'verification_document', resource_id: documentId, metadata: { decision, note },
  })

  console.log('[document/review] doc=%s decision=%s by=%s', documentId, decision, ctx.userId)
  return NextResponse.json({ ok: true, decision, confidence: 'medium' })
}
