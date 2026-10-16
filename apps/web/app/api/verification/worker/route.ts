import { NextRequest, NextResponse } from 'next/server'
import { makeVerificationIO } from '@/lib/verification/worker-io'
import { processVerificationChunk, type VChunkResult } from '@/lib/verification/worker'

// POST /api/verification/worker — drains verification_q in bounded chunks (Part 9.2 step 6).
// Invoked by pg_cron (via pg_net) or Vercel Cron; authenticated with the shared CRON_SECRET, exactly
// like /api/enrichment/worker. Verification rides the SAME queue runtime as enrichment (Part 9.1.3).

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

  const io = makeVerificationIO()
  const started = Date.now()
  const totals: VChunkResult = { read: 0, processed: 0, failed: 0, dlq: 0 }
  let chunks = 0

  do {
    const r = await processVerificationChunk(io)
    totals.read += r.read
    totals.processed += r.processed
    totals.failed += r.failed
    totals.dlq += r.dlq
    if (r.lastError) totals.lastError = r.lastError
    chunks++
    if (r.read === 0) break
  } while (Date.now() - started < BUDGET_MS)

  console.log('[verification/worker] chunks=%d %o', chunks, totals)
  return NextResponse.json({ ok: true, chunks, ...totals })
}
