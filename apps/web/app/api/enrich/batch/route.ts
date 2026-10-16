import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { enrichSubscribers } from '@/lib/enrichment/engine'

export const maxDuration = 300

const RETENTION_DAYS = 30
const QUALIFYING_STAGES = ['approaching_graduation', 'post_graduation_unverified']

export async function POST(req: NextRequest) {
  const pdlKey = process.env.LYCERT_PDL_API_KEY
  if (!pdlKey) {
    return NextResponse.json(
      {
        error: 'Enrichment API key not configured',
        hint: 'Add LYCERT_PDL_API_KEY to Vercel Preview environment variables',
      },
      { status: 503 },
    )
  }

  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let tenantId: string | null = null
  try {
    const payload = JSON.parse(Buffer.from(session.access_token.split('.')[1], 'base64').toString())
    tenantId = payload.tenant_id ?? null
  } catch { /* noop */ }
  if (!tenantId) return NextResponse.json({ error: 'No tenant in session' }, { status: 403 })

  const force = await req.json().then(b => b?.force === true).catch(() => false)
  const apolloKey = process.env.LYCERT_APOLLO_API_KEY ?? null

  const serviceDb = createServiceClient(
    process.env.NEXT_PUBLIC_LYCERT_SUPABASE_URL!,
    process.env.LYCERT_SUPABASE_SERVICE_ROLE_KEY!,
  )

  // Fetch qualifying subscribers
  const { data: subs, error: fetchErr } = await serviceDb
    .from('subscribers')
    .select('id, email, name, lifecycle_stage')
    .eq('tenant_id', tenantId)
    .in('lifecycle_stage', QUALIFYING_STAGES)

  if (fetchErr) {
    return NextResponse.json({ error: 'DB fetch failed', detail: fetchErr.message }, { status: 500 })
  }

  const allSubs = subs ?? []

  // Exclude recently enriched (within 30 days) unless forced. Miss rows
  // (provider_miss_reason set) never block a retry — PDL/Apollo misses do
  // not consume credits, and a later run may match.
  let toEnrich = allSubs
  if (!force) {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString()
    const { data: recentRows } = await serviceDb
      .from('subscriber_enrichment')
      .select('subscriber_id')
      .eq('tenant_id', tenantId)
      .is('provider_miss_reason', null)
      .gte('enriched_at', cutoff)

    const recentSet = new Set((recentRows ?? []).map(r => r.subscriber_id))
    toEnrich = allSubs.filter(s => !recentSet.has(s.id))
  }

  if (!toEnrich.length) {
    return NextResponse.json({ status: 'complete', total: 0, enriched: 0, miss: 0, errors: 0, gapFilled: 0 })
  }

  const totals = await enrichSubscribers(
    toEnrich.map(s => ({ id: s.id, email: s.email ?? '', name: s.name ?? null })),
    { serviceDb, tenantId, pdlKey, apolloKey, retentionDays: RETENTION_DAYS },
  )

  console.log('[enrich/batch] done tenant=%s total=%d enriched=%d miss=%d errors=%d gapFilled=%d',
    tenantId, toEnrich.length, totals.enriched, totals.miss, totals.errors, totals.gapFilled)

  return NextResponse.json({
    status: 'complete',
    total: toEnrich.length,
    enriched: totals.enriched,
    miss: totals.miss,
    errors: totals.errors,
    gapFilled: totals.gapFilled,
  })
}
