import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { EnrichAllButton } from '@/components/subscribers/enrich-all-button'
import { PreEnrichAllButton } from '@/components/subscribers/pre-enrich-all-button'
import { SubscribersTable, type SubscriberRowView } from '@/components/subscribers/subscribers-table'
import { EnrichmentActivityBar } from '@/components/subscribers/enrichment-activity-bar'
import { computeEarlySignals, computeTotalScore, computeTier } from '@/lib/utils/signals'

interface PageProps {
  searchParams: { q?: string; tier?: string; stage?: string; page?: string; view?: string }
}

type EnrichmentRow = {
  subscriber_id: string
  enrichment_provider: string
  provider_miss_reason: string | null
  completeness: string | null
  li_current_employer_name: string | null
  li_job_title: string | null
  li_job_title_levels: string[] | null
  li_education_end_date: string | null
  li_current_employer_domain: string | null
}

type ScoreRow = {
  total_score: number
  confidence_tier: number
  tier_label: string
  recommended_action: string
  aec_professional_confirmed: boolean
  scored_at: string
}

type SubRow = {
  id: string
  email: string
  name: string | null
  institution_name: string | null
  institution_country_normalized: string | null
  stated_graduation_date: string | null
  lifecycle_stage: string
  email_domain_type: string | null
  enrichment_priority: number
  account_country: string | null
  subscription_start_date: string | null
  subscription_end_date: string | null
  renewal_date: string | null
  auto_renew: boolean
  days_before_last_renewal: number | null
  created_at: string
  subscriber_scores: ScoreRow[]
}

export default async function SubscribersPage({ searchParams }: PageProps) {
  const supabase = await createClient()
  const q = searchParams.q ?? ''
  const tierFilter = searchParams.tier ?? ''
  const stageFilter = searchParams.stage ?? ''
  const view: 'live' | 'archived' = searchParams.view === 'archived' ? 'archived' : 'live'
  const page = Math.max(1, parseInt(searchParams.page ?? '1', 10))
  const pageSize = 50

  // Deletion is owner/admin-only; the table only renders selection controls when allowed.
  const { data: authData } = await supabase.auth.getUser()
  let canDelete = false
  if (authData.user) {
    const { data: tu } = (await supabase
      .from('tenant_users')
      .select('role')
      .eq('user_id', authData.user.id)
      .maybeSingle()) as unknown as { data: { role: string } | null }
    canDelete = tu?.role === 'owner' || tu?.role === 'admin'
  }

  // Tenant-wide count of subscribers with outstanding async (FullEnrich) enrichment — drives the
  // live "enriching in background" banner + auto-refresh. RLS on subscriber_enrichment scopes this
  // to the caller's tenant (subscriber_enrichment_tenant_isolation).
  const { count: pendingEnrichmentCount } = await (supabase
    .from('subscriber_enrichment')
    .select('subscriber_id', { count: 'exact', head: true })
    .not('pending_async_provider', 'is', null) as unknown as Promise<{ count: number | null }>)

  let query = supabase
    .from('subscribers')
    .select(
      `id, email, name, institution_name, institution_country_normalized, stated_graduation_date,
       lifecycle_stage, email_domain_type, enrichment_priority, account_country,
       subscription_start_date, subscription_end_date, renewal_date, auto_renew,
       days_before_last_renewal, created_at,
       subscriber_scores(total_score, confidence_tier, tier_label, recommended_action, aec_professional_confirmed, scored_at)`,
      { count: 'exact' },
    )
    .order('created_at', { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1)

  // Hide archived (soft-deleted) rows from the default list; the Archived view shows only those.
  query = view === 'archived' ? query.not('deleted_at', 'is', null) : query.is('deleted_at', null)
  if (q) query = query.or(`email.ilike.%${q}%,name.ilike.%${q}%`)
  if (stageFilter) query = query.eq('lifecycle_stage', stageFilter)

  const { data, count } = await (query as unknown as Promise<{ data: SubRow[] | null; count: number | null }>)
  const rows = data ?? []

  // Fetch enrichment status for all subscribers on this page
  const subIds = rows.map(s => s.id)
  let enrichments: EnrichmentRow[] = []
  if (subIds.length) {
    const { data: enrichData } = await (supabase
      .from('subscriber_enrichment')
      .select('subscriber_id, enrichment_provider, provider_miss_reason, completeness, li_current_employer_name, li_job_title, li_job_title_levels, li_education_end_date, li_current_employer_domain')
      .in('subscriber_id', subIds) as unknown as Promise<{ data: EnrichmentRow[] | null }>)
    enrichments = enrichData ?? []
  }

  const enrichMap = new Map<string, EnrichmentRow>((enrichments ?? []).map(e => [e.subscriber_id, e]))

  const processed = rows.map(s => {
    const scores = (s.subscriber_scores ?? []).sort(
      (a, b) => new Date(b.scored_at).getTime() - new Date(a.scored_at).getTime(),
    )
    const latestScore = scores[0] ?? null
    const enrichmentRow = enrichMap.get(s.id) ?? null
    // Miss rows (all providers tried, no match) must not feed signal computation — they only drive
    // the "No match" badge. Legacy engine set provider_miss_reason; the V2 waterfall records it as
    // completeness='miss' (enrichment_provider falls back to the last provider tried, so without this
    // a miss would wrongly show that provider's badge).
    const enrichMiss = !!enrichmentRow?.provider_miss_reason || enrichmentRow?.completeness === 'miss'
    const enrichment = enrichMiss ? null : enrichmentRow

    // Compute early signals from available data
    const earlySignals = computeEarlySignals({
      stated_graduation_date: s.stated_graduation_date,
      subscription_start_date: s.subscription_start_date,
      subscription_end_date: s.subscription_end_date,
      renewal_date: s.renewal_date,
      days_before_last_renewal: s.days_before_last_renewal,
      email_domain_type: s.email_domain_type,
      email: s.email,
      institution_name: s.institution_name,
      institution_country_normalized: s.institution_country_normalized,
      account_country: s.account_country,
      auto_renew: s.auto_renew,
    }, enrichment)

    const estimatedScore = latestScore?.total_score ?? computeTotalScore(earlySignals)
    const estimatedTier = latestScore?.confidence_tier ?? computeTier(estimatedScore).tier
    const signalsFired = earlySignals.filter(s => s.fired).length
    const dataGaps = earlySignals.filter(s => s.dataGap).length

    return { ...s, latestScore, enrichment, enrichMiss, earlySignals, estimatedScore, estimatedTier, signalsFired, dataGaps }
  })

  const filtered = tierFilter
    ? processed.filter(r => String(r.estimatedTier) === tierFilter)
    : processed

  const tableRows: SubscriberRowView[] = filtered.map(s => ({
    id: s.id,
    email: s.email,
    name: s.name,
    institution_name: s.institution_name,
    institution_country_normalized: s.institution_country_normalized,
    stated_graduation_date: s.stated_graduation_date,
    lifecycle_stage: s.lifecycle_stage,
    email_domain_type: s.email_domain_type,
    estimatedScore: s.estimatedScore,
    estimatedTier: s.estimatedTier,
    hasLatestScore: !!s.latestScore,
    signalsFired: s.signalsFired,
    dataGaps: s.dataGaps,
    enrichmentProvider: s.enrichment?.enrichment_provider ?? null,
    enrichMiss: s.enrichMiss,
  }))

  const totalPages = Math.ceil((count ?? 0) / pageSize)
  const qs = (extra?: Record<string, string>) => {
    const p: Record<string, string> = {}
    if (q) p.q = q
    if (stageFilter) p.stage = stageFilter
    if (tierFilter) p.tier = tierFilter
    if (view === 'archived') p.view = 'archived'
    Object.assign(p, extra)
    const s = new URLSearchParams(p).toString()
    return s ? `?${s}` : ''
  }
  const toggleHref = (target: 'live' | 'archived') => {
    const p = new URLSearchParams()
    if (q) p.set('q', q)
    if (stageFilter) p.set('stage', stageFilter)
    if (tierFilter) p.set('tier', tierFilter)
    if (target === 'archived') p.set('view', 'archived')
    const s = p.toString()
    return `/dashboard/subscribers${s ? `?${s}` : ''}`
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Subscribers</h1>
          <p className="mt-0.5 text-sm text-gray-500">{count ?? 0} total</p>
        </div>
        <div className="flex items-center gap-2">
          <PreEnrichAllButton />
          <EnrichAllButton />
          <Link
            href="/dashboard/subscribers/import"
            className="px-3 py-1.5 bg-gray-900 text-white text-sm font-medium rounded-lg hover:bg-gray-700 transition-colors"
          >
            Import CSV
          </Link>
        </div>
      </div>

      {/* Filters */}
      <form action="/dashboard/subscribers" method="GET" className="flex flex-wrap gap-2">
        <input
          type="search" name="q" defaultValue={q}
          placeholder="Search name or email…"
          className="flex-1 min-w-48 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent"
        />
        <select name="stage" defaultValue={stageFilter}
          className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-900">
          <option value="">All Stages</option>
          <option value="active_student">Active Student</option>
          <option value="approaching_graduation">Approaching Graduation</option>
          <option value="post_graduation_unverified">Post-Graduation</option>
          <option value="re_verification_pending">Re-Verification</option>
          <option value="converted">Converted</option>
        </select>
        <select name="tier" defaultValue={tierFilter}
          className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-900">
          <option value="">All Tiers</option>
          <option value="1">Tier 1 (High)</option>
          <option value="2">Tier 2 (Medium)</option>
          <option value="3">Tier 3 (Low)</option>
          <option value="0">Clean</option>
        </select>
        <button type="submit"
          className="px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-sm text-gray-700 hover:bg-gray-50 font-medium">
          Apply
        </button>
        {(q || stageFilter || tierFilter) && (
          <Link href="/dashboard/subscribers" className="px-3 py-1.5 text-sm text-gray-400 hover:text-gray-600">
            Clear
          </Link>
        )}
      </form>

      {/* Active / Archived toggle */}
      <div className="flex gap-1 text-sm">
        <Link href={toggleHref('live')}
          className={`px-3 py-1 rounded-lg font-medium ${view === 'live' ? 'bg-gray-900 text-white' : 'text-gray-500 hover:bg-gray-100'}`}>
          Active
        </Link>
        <Link href={toggleHref('archived')}
          className={`px-3 py-1 rounded-lg font-medium ${view === 'archived' ? 'bg-gray-900 text-white' : 'text-gray-500 hover:bg-gray-100'}`}>
          Archived
        </Link>
      </div>

      {/* Live enrichment status + table-only refresh (no full-page reload) */}
      <EnrichmentActivityBar pendingCount={pendingEnrichmentCount ?? 0} />

      {/* Table */}
      {tableRows.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <p className="text-gray-400 text-sm">
            {view === 'archived'
              ? 'No archived subscribers.'
              : q || stageFilter || tierFilter
              ? 'No subscribers match your filters.'
              : 'No subscribers yet. Import a CSV to get started.'}
          </p>
          {view === 'live' && !q && !stageFilter && !tierFilter && (
            <Link href="/dashboard/subscribers/import"
              className="mt-4 inline-block px-4 py-2 bg-gray-900 text-white text-sm font-medium rounded-lg hover:bg-gray-700">
              Import subscribers
            </Link>
          )}
        </div>
      ) : (
        <>
          <SubscribersTable rows={tableRows} canDelete={canDelete} view={view} />
          {totalPages > 1 && (
            <div className="flex justify-between items-center text-sm text-gray-500">
              <span>Page {page} of {totalPages}</span>
              <div className="flex gap-1.5">
                {page > 1 && (
                  <Link href={`/dashboard/subscribers${qs({ page: String(page - 1) })}`}
                    className="px-3 py-1 border border-gray-200 rounded text-sm hover:bg-gray-50">← Prev</Link>
                )}
                {page < totalPages && (
                  <Link href={`/dashboard/subscribers${qs({ page: String(page + 1) })}`}
                    className="px-3 py-1 border border-gray-200 rounded text-sm hover:bg-gray-50">Next →</Link>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
