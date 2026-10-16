import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { enrichSubscribers } from '@/lib/enrichment/engine'

export const maxDuration = 60

const RETENTION_DAYS = 30

// Single-subscriber enrich. Runs the same TS engine as the batch route —
// no Railway dependency. An explicit click always re-enriches (force).
export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
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

  const serviceDb = createServiceClient(
    process.env.NEXT_PUBLIC_LYCERT_SUPABASE_URL!,
    process.env.LYCERT_SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { data: sub, error: fetchErr } = await serviceDb
    .from('subscribers')
    .select('id, email, name')
    .eq('tenant_id', tenantId)
    .eq('id', params.id)
    .single()

  if (fetchErr || !sub) {
    return NextResponse.json({ error: 'Subscriber not found' }, { status: 404 })
  }

  const totals = await enrichSubscribers(
    [{ id: sub.id, email: sub.email ?? '', name: sub.name ?? null }],
    {
      serviceDb,
      tenantId,
      pdlKey,
      apolloKey: process.env.LYCERT_APOLLO_API_KEY ?? null,
      retentionDays: RETENTION_DAYS,
    },
  )

  console.log('[enrich/subscriber] done sub=%s enriched=%d miss=%d errors=%d gapFilled=%d',
    sub.id, totals.enriched, totals.miss, totals.errors, totals.gapFilled)

  return NextResponse.json({ status: 'complete', ...totals })
}
