import { NextRequest, NextResponse } from 'next/server'
import { makeCrmSyncIO } from '@/lib/crm/worker-io'
import { processCrmSyncChunk, type ChunkResult } from '@/lib/crm/worker'

// POST /api/crm/worker — drains crm_sync_q in bounded chunks (mirrors /api/enrichment/worker exactly).
// Invoked by pg_cron (via pg_net) or manually while M1 is still test-account-only — no cron schedule is
// created yet; that's a deliberate M1 scope boundary (see NEXT_STEPS.md), not an oversight.

export const maxDuration = 300
export const dynamic = 'force-dynamic'

const BUDGET_MS = 250_000

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const header = req.headers.get('authorization')
  return header === `Bearer ${secret}`
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const io = makeCrmSyncIO()
  const started = Date.now()
  const totals: ChunkResult = { read: 0, processed: 0, failed: 0, dlq: 0 }
  let chunks = 0

  do {
    const r = await processCrmSyncChunk(io)
    totals.read += r.read
    totals.processed += r.processed
    totals.failed += r.failed
    totals.dlq += r.dlq
    if (r.lastError) totals.lastError = r.lastError
    chunks++
    if (r.read === 0) break
  } while (Date.now() - started < BUDGET_MS)

  console.log('[crm/worker] chunks=%d %o', chunks, totals)
  return NextResponse.json({ ok: true, chunks, ...totals })
}
