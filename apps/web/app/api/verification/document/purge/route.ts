import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '@/lib/enrichment/worker-io'
import { purgedPatch } from '@/lib/verification/document/purge'

// POST /api/verification/document/purge — Stage G process-and-purge worker (CRON_SECRET-auth, like the
// other workers). Destroys raw document files whose storage_delete_at has arrived (verdict-reached rows are
// stamped now() so they purge on the next sweep; everything else by the 24h hard ceiling). Nulls the ref,
// stamps purged_at, and audit-logs every purge. This is the single most important safety mechanism — raw
// student documents never persist beyond the processing window.

export const dynamic = 'force-dynamic'
const BATCH = 200

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return req.headers.get('authorization') === `Bearer ${secret}`
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = serviceClient()
  const now = new Date()
  const { data, error } = await db
    .from('verification_documents')
    .select('id, tenant_id, transient_storage_ref, storage_delete_at, purged_at')
    .is('purged_at', null)
    .not('transient_storage_ref', 'is', null)
    .lte('storage_delete_at', now.toISOString())
    .limit(BATCH)
  if (error) return NextResponse.json({ error: 'select failed', detail: error.message }, { status: 500 })

  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>
  let purged = 0
  const patch = purgedPatch(now)
  for (const r of rows) {
    const id = String(r.id)
    const ref = r.transient_storage_ref as string
    // Delete the raw object first; only mark purged once the object is gone (so a storage failure retries).
    const del = await db.storage.from('verification-documents').remove([ref])
    if (del.error) { console.warn('[document/purge] storage remove failed id=%s: %s', id, del.error.message); continue }
    const upd = await db.from('verification_documents').update(patch).eq('id', id)
    if (upd.error) { console.warn('[document/purge] row update failed id=%s: %s', id, upd.error.message); continue }
    await db.from('audit_logs').insert({
      tenant_id: r.tenant_id, actor_type: 'system', action: 'verification_document.purged',
      resource_type: 'verification_document', resource_id: id, metadata: { storage_delete_at: r.storage_delete_at },
    })
    purged++
  }

  console.log('[document/purge] candidates=%d purged=%d', rows.length, purged)
  return NextResponse.json({ ok: true, candidates: rows.length, purged })
}
