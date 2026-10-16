import { NextRequest, NextResponse } from 'next/server'
import { makeScoringIO } from '@/lib/enrichment/worker-io'
import { processScoringChunk, type ChunkResult } from '@/lib/enrichment/worker'

// POST /api/scoring/worker — drains scoring_q in bounded chunks (CPU-bound, no external calls).
// Invoked by pg_cron (via pg_net) or Vercel Cron; authenticated with the shared CRON_SECRET.

export const maxDuration = 300
export const dynamic = 'force-dynamic'

const BUDGET_MS = 250_000

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return req.headers.get('authorization') === `Bearer ${secret}`
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const io = makeScoringIO()
  const started = Date.now()
  const totals: ChunkResult = { read: 0, processed: 0, blocked: 0, failed: 0, dlq: 0, skipped: 0 }
  let chunks = 0

  do {
    const r = await processScoringChunk(io)
    totals.read += r.read
    totals.processed += r.processed
    totals.failed += r.failed
    totals.dlq += r.dlq
    totals.skipped += r.skipped
    if (r.lastError) totals.lastError = r.lastError
    chunks++
    if (r.read === 0) break
  } while (Date.now() - started < BUDGET_MS)

  console.log('[scoring/worker] chunks=%d %o', chunks, totals)
  return NextResponse.json({ ok: true, chunks, ...totals })
}
