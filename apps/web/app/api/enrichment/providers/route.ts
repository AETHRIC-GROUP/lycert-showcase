import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'

// GET /api/enrichment/providers
// Returns the V2 waterfall provider registry merged with this tenant's overrides
// (tenant_waterfall_config) plus month-to-date spend per provider from
// enrichment_jobs.per_provider_stats. Degrades to an empty list if the V2 migrations
// (0024–0029) have not yet been applied — never throws to the page.

function serviceDb() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_LYCERT_SUPABASE_URL!,
    process.env.LYCERT_SUPABASE_SERVICE_ROLE_KEY!,
  )
}

async function getTenantId(): Promise<string | null> {
  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return null
  try {
    const payload = JSON.parse(Buffer.from(session.access_token.split('.')[1], 'base64').toString())
    return (payload.tenant_id as string | undefined) ?? null
  } catch {
    return null
  }
}

function monthStartIso(): string {
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString()
}

type ProviderRow = {
  provider_key: string
  display_name: string
  provider_type: string
  execution_mode: string
  enabled: boolean
  default_position: number | null
  cost_per_success_usd: number | null
  returns_education: boolean
  returns_employment_dates: boolean
  notes: string | null
}

export async function GET() {
  const tenantId = await getTenantId()
  if (!tenantId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = serviceDb()

  const { data: providers, error: provErr } = await db
    .from('enrichment_providers')
    .select('provider_key, display_name, provider_type, execution_mode, enabled, default_position, cost_per_success_usd, returns_education, returns_employment_dates, notes')

  // Migrations not applied yet (table missing) → degrade gracefully.
  if (provErr || !providers) {
    return NextResponse.json({ providers: [], usingTenantOverride: false, degraded: true })
  }

  const { data: overrides } = await db
    .from('tenant_waterfall_config')
    .select('provider_key, position, enabled')
    .eq('tenant_id', tenantId)

  const overrideMap = new Map((overrides ?? []).map(o => [o.provider_key, o]))

  // Month-to-date spend + hits per provider from enrichment_jobs.per_provider_stats.
  const { data: jobs } = await db
    .from('enrichment_jobs')
    .select('per_provider_stats')
    .eq('tenant_id', tenantId)
    .eq('status', 'completed')
    .gte('completed_at', monthStartIso())

  const mtd: Record<string, { cost: number; hits: number }> = {}
  for (const job of jobs ?? []) {
    const stats = (job.per_provider_stats ?? {}) as Record<string, { cost_usd?: number; hits?: number }>
    for (const [key, s] of Object.entries(stats)) {
      const e = (mtd[key] ??= { cost: 0, hits: 0 })
      e.cost += Number(s.cost_usd ?? 0)
      e.hits += Number(s.hits ?? 0)
    }
  }

  const merged = (providers as ProviderRow[]).map(p => {
    const ov = overrideMap.get(p.provider_key)
    return {
      providerKey: p.provider_key,
      displayName: p.display_name,
      providerType: p.provider_type,
      executionMode: p.execution_mode,
      isValidation: p.provider_type === 'validation',
      enabled: ov ? ov.enabled : p.enabled,
      position: ov ? ov.position : p.default_position,
      costPerSuccessUsd: p.cost_per_success_usd,
      returnsEducation: p.returns_education,
      returnsEmploymentDates: p.returns_employment_dates,
      notes: p.notes,
      mtdCostUsd: Math.round((mtd[p.provider_key]?.cost ?? 0) * 100) / 100,
      mtdHits: mtd[p.provider_key]?.hits ?? 0,
    }
  })

  // Validation stage first (no position), then enrichment cascade by effective position.
  merged.sort((a, b) => {
    if (a.isValidation !== b.isValidation) return a.isValidation ? -1 : 1
    return (a.position ?? 99) - (b.position ?? 99)
  })

  return NextResponse.json({
    providers: merged,
    usingTenantOverride: (overrides ?? []).length > 0,
    degraded: false,
  })
}
