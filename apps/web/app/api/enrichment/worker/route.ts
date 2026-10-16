import { NextRequest, NextResponse } from 'next/server'
import { makeEnrichmentIO } from '@/lib/enrichment/worker-io'
import { processEnrichmentChunk, type ChunkResult } from '@/lib/enrichment/worker'

// POST /api/enrichment/worker — drains enrichment_jobs_q in bounded chunks.
// Invoked by pg_cron (via pg_net) or Vercel Cron; authenticated with the shared CRON_SECRET.
// One invocation processes several chunks until the queue is empty or the time budget is spent,
// so a backlog clears without waiting for the next cron tick.

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

  const io = makeEnrichmentIO()
  const started = Date.now()
  const totals: ChunkResult = { read: 0, processed: 0, blocked: 0, failed: 0, dlq: 0, skipped: 0 }
  let chunks = 0

  do {
    const r = await processEnrichmentChunk(io)
    totals.read += r.read
    totals.processed += r.processed
    totals.blocked += r.blocked
    totals.failed += r.failed
    totals.dlq += r.dlq
    totals.skipped += r.skipped
    if (r.lastError) totals.lastError = r.lastError
    chunks++
    if (r.read === 0) break
  } while (Date.now() - started < BUDGET_MS)

  console.log('[enrichment/worker] chunks=%d %o', chunks, totals)
  return NextResponse.json({ ok: true, chunks, ...totals })
}
