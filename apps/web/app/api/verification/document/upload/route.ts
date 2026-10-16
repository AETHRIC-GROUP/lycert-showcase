import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { serviceClient } from '@/lib/enrichment/worker-io'
import { verifyLinkToken } from '@/lib/verification/link-token'
import { docReviewEnabled, checkUploadAllowed } from '@/lib/verification/document/gate'
import { makeDocumentProvider } from '@/lib/verification/document/provider'
import { runDocumentPipeline } from '@/lib/verification/document/pipeline'

// POST /api/verification/document/upload — Stage A capture (LYCERT_DOCUMENT_REVIEW_ARCHITECTURE.md).
// GATED OFF by default: unless LYCERT_DOC_REVIEW_ENABLED=true AND a document-specific consent exists, this
// returns 403 and STORES NOTHING — no raw student document is ever written before the Part 9 gate opens.
// When enabled: store the file (24h hard-ceiling delete), run the pipeline (stub today) → pending_review.
// Body: { token, fileBase64, contentType }.

export const dynamic = 'force-dynamic'
// The Claude-vision read (when LYCERT_ANTHROPIC_API_KEY is set) runs inline and can take tens of seconds.
// Moving OCR onto verification_q becomes worthwhile when the multi-stage forensics backend lands.
export const maxDuration = 120
type Row = Record<string, unknown>
const ALLOWED_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/heic'])
const MAX_BYTES = 10 * 1024 * 1024
const STORAGE_TTL_MS = 24 * 60 * 60 * 1000 // hard ceiling (Part 5)

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const v = verifyLinkToken(typeof body?.token === 'string' ? body.token : '')
  if (!v.valid) return NextResponse.json({ error: `invalid link (${v.reason})` }, { status: 400 })
  const { sub: subscriberId, ten: tenantId } = v.payload
  const db = serviceClient()

  // Document-specific consent (Stage A, scope 'enrollment_document') must exist + be active.
  const nowIso = new Date().toISOString()
  const { data: consent } = await db
    .from('verification_consents').select('id')
    .eq('subscriber_id', subscriberId).eq('tenant_id', tenantId).eq('scope', 'enrollment_document')
    .is('revoked_at', null).or(`expires_at.is.null,expires_at.gt.${nowIso}`)
    .order('granted_at', { ascending: false }).limit(1).maybeSingle()

  const gate = checkUploadAllowed(docReviewEnabled(), !!consent)
  if (!gate.allowed) {
    // SAFETY: nothing stored. This is the default path until the gate opens.
    return NextResponse.json({ error: 'document upload not available', reason: gate.reason }, { status: 403 })
  }

  // ── below here only runs when the gate is fully open (Part 9) ──
  const fileBase64 = typeof body?.fileBase64 === 'string' ? body.fileBase64 : ''
  const contentType = typeof body?.contentType === 'string' ? body.contentType : ''
  if (!ALLOWED_TYPES.has(contentType)) return NextResponse.json({ error: 'unsupported file type' }, { status: 400 })
  const buf = Buffer.from(fileBase64, 'base64')
  if (!buf.length || buf.length > MAX_BYTES) return NextResponse.json({ error: 'file empty or too large' }, { status: 400 })

  const consentId = String((consent as Row).id)
  const now = new Date()
  const ext = contentType === 'application/pdf' ? 'pdf' : contentType.split('/')[1]
  const key = `${tenantId}/${subscriberId}/${crypto.randomUUID()}.${ext}`
  const up = await db.storage.from('verification-documents').upload(key, buf, { contentType, upsert: false })
  if (up.error) return NextResponse.json({ error: 'upload failed', detail: up.error.message }, { status: 500 })

  // Load the subscriber's claim for cross-reference.
  const { data: sub } = await db.from('subscribers').select('name, institution_name, stated_graduation_date')
    .eq('id', subscriberId).maybeSingle()
  const s = (sub ?? {}) as Row
  const claim = {
    name: (s.name as string | null) ?? null,
    institution: (s.institution_name as string | null) ?? null,
    statedGraduationDate: (s.stated_graduation_date as string | null) ?? null,
  }

  // Insert the transient row (raw file ref + 24h hard ceiling), then run the pipeline (stub) → pending_review.
  const { data: inserted, error: insErr } = await db.from('verification_documents').insert({
    tenant_id: tenantId, subscriber_id: subscriberId, consent_id: consentId,
    transient_storage_ref: key, storage_delete_at: new Date(now.getTime() + STORAGE_TTL_MS).toISOString(),
    review_status: 'pending_ocr',
  }).select('id').single()
  if (insErr || !inserted) return NextResponse.json({ error: 'row insert failed', detail: insErr?.message }, { status: 500 })
  const documentId = String((inserted as Row).id)

  await db.from('audit_logs').insert({
    tenant_id: tenantId, actor_type: 'system', action: 'verification_document.uploaded',
    resource_type: 'verification_document', resource_id: documentId, metadata: { content_type: contentType },
  })

  // Pipeline: Claude-vision classify+extract when LYCERT_ANTHROPIC_API_KEY is set, else the stub (no
  // extraction → 'inconclusive'). Either way the result is pending_review — never auto-cleared.
  const result = await runDocumentPipeline(
    { bucket: 'verification-documents', key }, claim,
    {
      provider: makeDocumentProvider({
        download: async (ref) => {
          const dl = await db.storage.from(ref.bucket).download(ref.key)
          if (dl.error || !dl.data) throw new Error(`storage download failed: ${dl.error?.message ?? 'no data'}`)
          return { bytes: Buffer.from(await dl.data.arrayBuffer()), contentType: dl.data.type || contentType }
        },
      }),
      // Institution Trust check: a hit in the academic_domains reference set (10,570 institutions) proves
      // the name is real. A miss is UNKNOWN (null), never false — absence from the set must not penalise.
      lookupInstitutionReal: async (name) => {
        const needle = (name ?? '').trim()
        if (needle.length < 3) return null
        const { data: hit } = await db.from('academic_domains').select('domain').ilike('name', needle).limit(1).maybeSingle()
        return hit ? true : null
      },
      // Prior submissions' hashes for repeat-document detection (this tenant, excluding this row).
      priorHashes: async () => {
        const { data: rows } = await db.from('verification_documents').select('perceptual_hash')
          .eq('tenant_id', tenantId).neq('id', documentId).not('perceptual_hash', 'is', null).limit(500)
        return ((rows ?? []) as Row[]).map(r => String(r.perceptual_hash))
      },
    },
  )
  await db.from('verification_documents').update(result).eq('id', documentId)

  return NextResponse.json({ ok: true, documentId, status: 'pending_review' })
}
