'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { LIFECYCLE_LABELS, LIFECYCLE_COLORS, type LifecycleStage } from '@/lib/utils/lifecycle'
import { computeEarlySignals, computeTotalScore, computeTier, type SignalResult } from '@/lib/utils/signals'

// ── Types ─────────────────────────────────────────────────────────────────────

type Score = {
  id: string
  scored_at: string
  total_score: number
  confidence_tier: number
  tier_label: string
  data_confidence: string
  primary_signal: string | null
  supporting_signals: string | null
  signals_fired: string | null
  data_gaps: string | null
  aec_professional_confirmed: boolean
  recommended_action: string
  ai_explanation: string | null
}

type Enrichment = {
  linkedin_profile_url: string | null
  li_current_employer_name: string | null
  li_current_employer_domain: string | null
  li_current_employer_linkedin_url: string | null
  li_job_title: string | null
  li_job_title_levels: string[] | null
  li_job_start_date: string | null
  li_job_end_date: string | null
  li_employer_size: string | null
  li_employer_industry: string | null
  li_education_institution: string | null
  li_education_end_date: string | null
  li_country: string | null
  li_state: string | null
  li_city: string | null
  li_skills: string[] | null
  pdl_likelihood_score: number | null
  pdl_person_id: string | null
  enrichment_provider: string
  provider_miss_reason: string | null
  enriched_at: string
  delete_at: string
} | null

type Case = {
  id: string
  opened_at: string
  status: string
  decision: string
  decided_at: string | null
  score_id: string
}

type AuditEntry = {
  id: string
  created_at: string
  action: string
  actor_type: string
  resource_type: string
  metadata: Record<string, unknown> | null
}

type Subscriber = {
  id: string
  email: string
  name: string | null
  external_id: string | null
  account_name: string | null
  account_country: string | null
  institution_name: string | null
  institution_location: string | null
  institution_country_normalized: string | null
  institution_name_normalized: string | null
  institution_domain_verified: string | null
  stated_graduation_date: string | null
  plan_name: string | null
  plan_type: string
  subscription_start_date: string | null
  subscription_end_date: string | null
  renewal_date: string | null
  auto_renew: boolean
  days_before_last_renewal: number | null
  email_domain_type: string | null
  enrichment_priority: number
  lifecycle_stage: string
  last_scored_at: string | null
  created_at: string
  updated_at: string
}

interface Props {
  subscriber: Subscriber
  scores: Score[]
  enrichment: Enrichment
  cases: Case[]
  auditLog: AuditEntry[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeLocationStr(val: string | null | undefined): string | null {
  if (!val) return null
  // Coerce booleans stored as strings (PDL bug)
  if (val === 'true' || val === 'false') return null
  return val
}

function safeUrl(url: string | null): string | null {
  if (!url) return null
  if (url.startsWith('http://') || url.startsWith('https://')) return url
  return `https://${url}`
}

const DOMAIN_BADGE: Record<string, { label: string; cls: string }> = {
  academic:   { label: 'Academic',   cls: 'bg-blue-50 text-blue-700 ring-1 ring-blue-200' },
  personal:   { label: 'Personal',  cls: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200' },
  corporate:  { label: 'Corporate', cls: 'bg-red-50 text-red-700 ring-1 ring-red-200' },
  disposable: { label: 'Disposable',cls: 'bg-purple-50 text-purple-700 ring-1 ring-purple-200' },
}

const PROVIDER_BADGE: Record<string, { label: string; cls: string }> = {
  pdl:          { label: 'PDL',    cls: 'bg-violet-50 text-violet-700 ring-1 ring-violet-200' },
  apollo:       { label: 'Apollo', cls: 'bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200' },
  pdl_identify: { label: 'PDL ID', cls: 'bg-violet-50 text-violet-700 ring-1 ring-violet-200' },
}

const TIER_STYLE: Record<number, string> = {
  1: 'bg-red-50 text-red-700 ring-1 ring-red-200',
  2: 'bg-orange-50 text-orange-700 ring-1 ring-orange-200',
  3: 'bg-yellow-50 text-yellow-700 ring-1 ring-yellow-200',
  0: 'bg-green-50 text-green-700 ring-1 ring-green-200',
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Field({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs font-medium text-gray-400 uppercase tracking-wide">{label}</dt>
      <dd className={`mt-1 text-sm text-gray-900 ${mono ? 'font-mono' : ''}`}>
        {value ?? <span className="text-gray-300">—</span>}
      </dd>
    </div>
  )
}

function SectionHeader({ title }: { title: string }) {
  return <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">{title}</h3>
}

function EnrichButton({ subscriberId, hasData }: { subscriberId: string; hasData: boolean }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  async function handleEnrich() {
    setLoading(true)
    setResult(null)
    const res = await fetch(`/api/enrich/subscriber/${subscriberId}`, { method: 'POST' })
    const body = await res.json()
    setLoading(false)
    if (!res.ok) { setResult(body.hint ?? body.error ?? 'Enrichment failed'); return }
    if (body.enriched > 0) {
      setResult(body.gapFilled > 0 ? 'Enriched (PDL + Apollo gap-fill)' : 'Enriched')
      router.refresh()
    } else if (body.miss > 0) {
      setResult('No match in PDL or Apollo')
      router.refresh()
    } else {
      setResult('Provider error — try again shortly')
    }
  }

  return (
    <div className="flex items-center gap-2">
      {result && <span className="text-xs text-gray-400">{result}</span>}
      <button
        onClick={handleEnrich}
        disabled={loading}
        className="px-3 py-1.5 bg-gray-900 text-white text-xs font-medium rounded-lg hover:bg-gray-700 disabled:opacity-40 transition-colors"
      >
        {loading ? 'Enriching…' : hasData ? 'Re-enrich' : 'Enrich'}
      </button>
    </div>
  )
}

// ── Signal row ────────────────────────────────────────────────────────────────

function SignalRow({ signal }: { signal: SignalResult }) {
  const tierColor =
    signal.tier === 'A' ? 'text-red-500' :
    signal.tier === 'B' ? 'text-amber-500' : 'text-violet-500'

  return (
    <tr className={signal.fired ? 'bg-white' : 'bg-gray-50/40'}>
      <td className="px-4 py-2.5 whitespace-nowrap">
        <span className={`text-xs font-bold font-mono ${tierColor}`}>{signal.key}</span>
      </td>
      <td className="px-4 py-2.5">
        <span className="text-sm text-gray-800">{signal.label}</span>
      </td>
      <td className="px-4 py-2.5">
        {signal.dataGap ? (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-gray-100 text-gray-400">
            Data gap
          </span>
        ) : signal.fired ? (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-red-50 text-red-600 font-medium">
            Fired
          </span>
        ) : (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-green-50 text-green-600">
            Clean
          </span>
        )}
      </td>
      <td className="px-4 py-2.5 text-right">
        <span className={`text-sm font-semibold font-mono ${signal.points > 0 ? 'text-gray-900' : 'text-gray-300'}`}>
          {signal.points > 0 ? `+${signal.points}` : '0'}
        </span>
      </td>
      <td className="px-4 py-2.5 text-xs text-gray-500 max-w-xs">{signal.description}</td>
    </tr>
  )
}

// ── Score gauge ───────────────────────────────────────────────────────────────

function ScoreGauge({ score, tier, isEstimate }: { score: number; tier: number; isEstimate: boolean }) {
  const pct = Math.min(100, score)
  const barColor =
    tier === 1 ? 'bg-red-500' :
    tier === 2 ? 'bg-orange-400' :
    tier === 3 ? 'bg-yellow-400' : 'bg-green-400'
  const tierLabel = tier === 0 ? 'Clean' : tier === 1 ? 'Tier 1 — High Risk' : tier === 2 ? 'Tier 2 — Medium Risk' : 'Tier 3 — Low Risk'

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="text-3xl font-bold text-gray-900 font-mono">{score}</div>
          <div className="text-sm text-gray-500 mt-0.5">{tierLabel}</div>
        </div>
        <span className={`px-2.5 py-1 rounded-lg text-xs font-semibold ${TIER_STYLE[tier]}`}>
          {tier === 0 ? 'Clean' : `Tier ${tier}`}
        </span>
      </div>
      <div className="w-full bg-gray-100 rounded-full h-1.5">
        <div className={`h-1.5 rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
      {isEstimate && (
        <p className="text-xs text-gray-400 mt-2">
          Estimated from early signals — run scoring engine for authoritative score
        </p>
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

const TABS = ['Overview', 'Signals', 'Profile', 'Enrichment', 'Cases', 'Timeline']

export function SubscriberTabs({ subscriber: s, scores, enrichment, cases, auditLog }: Props) {
  const [active, setActive] = useState(0)

  // A miss row records that both providers were tried and neither matched.
  // For signal computation it must behave like "no enrichment" (data gaps,
  // never clean) — it only affects what the UI displays.
  const isMiss = !!enrichment?.provider_miss_reason
  const enrichData = isMiss ? null : enrichment

  const latestScore = scores[0] ?? null
  const earlySignals = computeEarlySignals({
    stated_graduation_date: s.stated_graduation_date,
    subscription_start_date: s.subscription_start_date,
    subscription_end_date: s.subscription_end_date,
    renewal_date: s.renewal_date,
    days_before_last_renewal: s.days_before_last_renewal,
    email_domain_type: s.email_domain_type,
    email: s.email,
    institution_name: s.institution_name,
    institution_country_normalized: s.institution_country_normalized ?? null,
    account_country: s.account_country,
    auto_renew: s.auto_renew,
  }, enrichData ? {
    li_job_title: enrichData.li_job_title,
    li_current_employer_name: enrichData.li_current_employer_name,
    li_current_employer_domain: enrichData.li_current_employer_domain,
    li_job_title_levels: enrichData.li_job_title_levels,
    li_education_end_date: enrichData.li_education_end_date,
    enrichment_provider: enrichData.enrichment_provider,
  } : null)

  const estimatedScore = latestScore?.total_score ?? computeTotalScore(earlySignals)
  const estimatedTier = latestScore?.confidence_tier ?? computeTier(estimatedScore).tier
  const isEstimate = !latestScore

  const signalsFired = earlySignals.filter(sig => sig.fired)
  const dataGaps = earlySignals.filter(sig => sig.dataGap)
  const domainBadge = s.email_domain_type ? DOMAIN_BADGE[s.email_domain_type] : null
  const providerBadge = enrichData ? PROVIDER_BADGE[enrichData.enrichment_provider] : null

  // Safe location strings (filter out boolean "true" values from PDL bug)
  const liCity = safeLocationStr(enrichData?.li_city)
  const liState = safeLocationStr(enrichData?.li_state)
  const liCountry = safeLocationStr(enrichData?.li_country)
  const locationStr = [liCity, liState, liCountry].filter(Boolean).join(', ') || null
  const linkedinUrl = safeUrl(enrichData?.linkedin_profile_url ?? null)
  const employerUrl = safeUrl(enrichData?.li_current_employer_linkedin_url ?? null)

  return (
    <div>
      {/* Header */}
      <div className="mb-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-gray-900 truncate">{s.name ?? s.email}</h1>
            <p className="text-sm text-gray-500 mt-1">{s.email}</p>
            <div className="flex flex-wrap items-center gap-2 mt-2">
              <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${LIFECYCLE_COLORS[s.lifecycle_stage as LifecycleStage] ?? 'bg-gray-100 text-gray-500'}`}>
                {LIFECYCLE_LABELS[s.lifecycle_stage as LifecycleStage] ?? s.lifecycle_stage}
              </span>
              {domainBadge && (
                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${domainBadge.cls}`}>
                  {domainBadge.label} email
                </span>
              )}
              {providerBadge && (
                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${providerBadge.cls}`}>
                  Enriched via {providerBadge.label}
                </span>
              )}
              {isMiss && (
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-500 ring-1 ring-gray-200">
                  No provider match
                </span>
              )}
              {s.enrichment_priority > 0 && (
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">
                  Priority {s.enrichment_priority}
                </span>
              )}
            </div>
          </div>
          <div className="flex-shrink-0 text-right">
            <div className={`text-2xl font-bold font-mono ${
              estimatedTier === 1 ? 'text-red-600' :
              estimatedTier === 2 ? 'text-orange-500' :
              estimatedTier === 3 ? 'text-yellow-600' : 'text-green-600'
            }`}>{estimatedScore}</div>
            <div className="text-xs text-gray-400 mt-0.5">{isEstimate ? 'est. score' : 'score'}</div>
            <div className={`text-xs font-medium mt-1 ${
              estimatedTier === 1 ? 'text-red-600' :
              estimatedTier === 2 ? 'text-orange-500' :
              estimatedTier === 3 ? 'text-yellow-600' : 'text-green-600'
            }`}>
              {estimatedTier === 0 ? 'Clean' : `Tier ${estimatedTier}`}
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200 mb-5">
        <nav className="-mb-px flex gap-1">
          {TABS.map((tab, i) => (
            <button
              key={tab}
              onClick={() => setActive(i)}
              className={`px-3 pb-3 pt-1 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                active === i
                  ? 'border-gray-900 text-gray-900'
                  : 'border-transparent text-gray-400 hover:text-gray-600 hover:border-gray-300'
              }`}
            >
              {tab}
              {tab === 'Cases' && cases.length > 0 && (
                <span className="ml-1.5 bg-gray-100 text-gray-600 text-xs rounded-full px-1.5 py-0.5">{cases.length}</span>
              )}
              {tab === 'Signals' && signalsFired.length > 0 && (
                <span className="ml-1.5 bg-red-100 text-red-600 text-xs rounded-full px-1.5 py-0.5">{signalsFired.length}</span>
              )}
            </button>
          ))}
        </nav>
      </div>

      {/* ── Tab 0: Overview ────────────────────────────────────────────────────── */}
      {active === 0 && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <ScoreGauge score={estimatedScore} tier={estimatedTier} isEstimate={isEstimate} />

            {/* Signal summary */}
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <SectionHeader title="Signal Summary" />
              <div className="space-y-2">
                {(['A', 'B', 'C'] as const).map(tier => {
                  const tierSignals = earlySignals.filter(sg => sg.tier === tier)
                  const fired = tierSignals.filter(sg => sg.fired)
                  const pts = tierSignals.reduce((sum, sg) => sum + sg.points, 0)
                  const tierLabel = tier === 'A' ? 'Timing' : tier === 'B' ? 'Identity' : 'LinkedIn'
                  const color = tier === 'A' ? 'text-red-500' : tier === 'B' ? 'text-amber-500' : 'text-violet-500'
                  return (
                    <div key={tier} className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <span className={`font-bold font-mono text-xs ${color}`}>Tier {tier}</span>
                        <span className="text-gray-500">{tierLabel}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-gray-400 text-xs">{fired.length}/{tierSignals.length} fired</span>
                        <span className={`font-semibold font-mono text-xs ${pts > 0 ? 'text-gray-900' : 'text-gray-300'}`}>+{pts}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="mt-3 pt-3 border-t border-gray-100 flex justify-between text-xs">
                <span className="text-gray-400">{dataGaps.length} data gaps</span>
                <button onClick={() => setActive(1)} className="text-gray-900 font-medium hover:underline">
                  View all signals →
                </button>
              </div>
            </div>

            {/* Quick facts */}
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <SectionHeader title="Quick Facts" />
              <dl className="space-y-2.5">
                <Field label="Institution" value={s.institution_name_normalized ?? s.institution_name} />
                <Field label="Graduation" value={
                  s.stated_graduation_date
                    ? new Date(s.stated_graduation_date).toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' })
                    : null
                } />
                <Field label="Email domain" value={
                  domainBadge
                    ? <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${domainBadge.cls}`}>{domainBadge.label}</span>
                    : null
                } />
                {enrichData && (
                  <Field label="Current employer" value={enrichData.li_current_employer_name} />
                )}
                {enrichData && (
                  <Field label="Job title" value={enrichData.li_job_title} />
                )}
              </dl>
            </div>
          </div>

          {/* Recommended action */}
          {latestScore?.recommended_action && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
              <div className="text-xs font-semibold text-amber-600 uppercase tracking-wide mb-1">Recommended Action</div>
              <p className="text-sm text-amber-900">{latestScore.recommended_action}</p>
            </div>
          )}
        </div>
      )}

      {/* ── Tab 1: Signals ─────────────────────────────────────────────────────── */}
      {active === 1 && (
        <div className="space-y-4">
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-gray-900">CEDS Signal Breakdown</h3>
                <p className="text-xs text-gray-400 mt-0.5">
                  {isEstimate ? 'Early signals — estimated score. Authoritative score requires Railway scoring engine.' : `Score as of ${new Date(latestScore!.scored_at).toLocaleDateString('en-GB')}.`}
                </p>
              </div>
              <div className={`text-2xl font-bold font-mono ${
                estimatedTier === 1 ? 'text-red-600' :
                estimatedTier === 2 ? 'text-orange-500' :
                estimatedTier === 3 ? 'text-yellow-600' : 'text-green-600'
              }`}>{estimatedScore} pts</div>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-400 w-12">Signal</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-400">Name</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-400 w-20">Status</th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-400 w-16">Points</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-400">Evidence</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {earlySignals.map(signal => <SignalRow key={signal.key} signal={signal} />)}
              </tbody>
            </table>
          </div>

          <div className="bg-gray-50 rounded-xl border border-gray-200 p-4 text-xs text-gray-500">
            <strong>Note:</strong> Signals A3 and C1–C4 require enrichment data or subscription proof dates not captured at import.
            Data gaps score 0 and are never penalised — this is a legal requirement.
          </div>
        </div>
      )}

      {/* ── Tab 2: Profile ─────────────────────────────────────────────────────── */}
      {active === 2 && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-6">
          <section>
            <SectionHeader title="Identity" />
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Field label="Full name" value={s.name} />
              <Field label="Email" value={s.email} />
              <Field label="External ID" value={s.external_id} mono />
            </dl>
          </section>
          <hr className="border-gray-100" />
          <section>
            <SectionHeader title="Qualification" />
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Field label="Institution" value={s.institution_name} />
              <Field label="Normalized name" value={s.institution_name_normalized} />
              <Field label="Institution country" value={s.institution_country_normalized} />
              <Field label="Domain verified" value={s.institution_domain_verified} />
              <Field label="Graduation date" value={
                s.stated_graduation_date
                  ? new Date(s.stated_graduation_date).toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' })
                  : null
              } />
              <Field label="Days before renewal" value={s.days_before_last_renewal != null ? String(s.days_before_last_renewal) : null} mono />
            </dl>
          </section>
          <hr className="border-gray-100" />
          <section>
            <SectionHeader title="Subscription" />
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Field label="Plan" value={s.plan_name} />
              <Field label="Plan type" value={s.plan_type} />
              <Field label="Start date" value={s.subscription_start_date} mono />
              <Field label="End date" value={s.subscription_end_date} mono />
              <Field label="Renewal date" value={s.renewal_date} mono />
              <Field label="Auto-renew" value={s.auto_renew ? 'Yes' : 'No'} />
            </dl>
          </section>
          <hr className="border-gray-100" />
          <section>
            <SectionHeader title="Geography" />
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Field label="Account country" value={s.account_country} />
              <Field label="Account name" value={s.account_name} />
            </dl>
          </section>
        </div>
      )}

      {/* ── Tab 3: Enrichment ──────────────────────────────────────────────────── */}
      {active === 3 && (
        <div className="space-y-4">
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h3 className="text-sm font-semibold text-gray-900">Person Enrichment</h3>
                {enrichData && (
                  <p className="text-xs text-gray-400 mt-0.5">
                    Via {enrichData.enrichment_provider.toUpperCase()}
                    {enrichData.pdl_likelihood_score != null && ` · Likelihood ${enrichData.pdl_likelihood_score}/10`}
                    {' · '}Enriched {new Date(enrichData.enriched_at).toLocaleDateString('en-GB')}
                    {' · '}Expires {new Date(enrichData.delete_at).toLocaleDateString('en-GB')}
                  </p>
                )}
                {isMiss && enrichment && (
                  <p className="text-xs text-gray-400 mt-0.5">
                    Last attempted {new Date(enrichment.enriched_at).toLocaleDateString('en-GB')}
                  </p>
                )}
              </div>
              <EnrichButton subscriberId={s.id} hasData={!!enrichData} />
            </div>

            {isMiss ? (
              enrichment?.provider_miss_reason?.endsWith('apollo_unavailable') ? (
                <div className="text-center py-10 text-sm text-gray-500">
                  <p className="font-medium text-gray-600">No PDL match — Apollo fallback unavailable</p>
                  <p className="mt-1 text-xs text-gray-400 max-w-md mx-auto">
                    PDL has no profile for this email/name. The Apollo fallback could not
                    run because the connected Apollo account is on a free plan, which does
                    not include API access to person enrichment. Upgrading the Apollo plan
                    enables the fallback; re-enriching afterwards will retry automatically.
                  </p>
                </div>
              ) : (
                <div className="text-center py-10 text-sm text-gray-500">
                  <p className="font-medium text-gray-600">No match found in PDL or Apollo</p>
                  <p className="mt-1 text-xs text-gray-400 max-w-md mx-auto">
                    Neither provider has a profile for this email/name. This is common for
                    personal email addresses with no public professional footprint.
                    Pre-enrichment signals below still contribute to the risk score, and
                    re-enriching later may match if the person builds a profile.
                  </p>
                </div>
              )
            ) : !enrichData ? (
              <div className="text-center py-10 text-sm text-gray-400">
                <p>No enrichment data yet.</p>
                <p className="mt-1 text-xs">Click Enrich to fetch LinkedIn data via PDL / Apollo.</p>
              </div>
            ) : (
              <div className="space-y-5">
                {/* LinkedIn identity */}
                {linkedinUrl && (
                  <div>
                    <dt className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-1">LinkedIn Profile</dt>
                    <a href={linkedinUrl} target="_blank" rel="noopener noreferrer"
                      className="text-sm text-blue-600 hover:underline break-all">
                      {enrichData.linkedin_profile_url}
                    </a>
                  </div>
                )}

                <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                  <Field label="Job title" value={enrichData.li_job_title} />
                  <Field label="Seniority level" value={(enrichData.li_job_title_levels ?? []).join(', ') || null} />
                  <Field label="Job start date" value={enrichData.li_job_start_date} mono />
                </dl>

                <hr className="border-gray-100" />
                <div>
                  <SectionHeader title="Current Employer" />
                  <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                    <Field label="Company" value={enrichData.li_current_employer_name} />
                    <Field label="Industry" value={enrichData.li_employer_industry} />
                    <Field label="Size" value={enrichData.li_employer_size} />
                    <Field label="Domain" value={enrichData.li_current_employer_domain} mono />
                    {employerUrl && (
                      <div>
                        <dt className="text-xs font-medium text-gray-400 uppercase tracking-wide">LinkedIn</dt>
                        <dd className="mt-1">
                          <a href={employerUrl} target="_blank" rel="noopener noreferrer"
                            className="text-sm text-blue-600 hover:underline break-all">
                            {enrichData.li_current_employer_linkedin_url}
                          </a>
                        </dd>
                      </div>
                    )}
                  </dl>
                </div>

                <hr className="border-gray-100" />
                <div>
                  <SectionHeader title="Education (LinkedIn)" />
                  <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                    <Field label="Institution" value={enrichData.li_education_institution} />
                    <Field label="End date" value={enrichData.li_education_end_date} mono />
                  </dl>
                  {enrichData.enrichment_provider === 'apollo' && (
                    <p className="text-xs text-gray-400 mt-2">Apollo does not return education history — C3 signal will be a data gap.</p>
                  )}
                </div>

                <hr className="border-gray-100" />
                <div>
                  <SectionHeader title="Location" />
                  <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                    <Field label="City" value={liCity} />
                    <Field label="State / Region" value={liState} />
                    <Field label="Country" value={liCountry} />
                  </dl>
                  {!locationStr && (
                    <p className="text-xs text-gray-400 mt-2">Location data not available from this enrichment source.</p>
                  )}
                </div>

                {(enrichData.li_skills ?? []).length > 0 && (
                  <>
                    <hr className="border-gray-100" />
                    <div>
                      <SectionHeader title="Skills" />
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {(enrichData.li_skills ?? []).map(skill => (
                          <span key={skill} className="px-2 py-0.5 bg-gray-100 text-gray-600 rounded text-xs">{skill}</span>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Pre-enrichment signals */}
          {(s.email_domain_type || s.institution_name_normalized || s.institution_country_normalized) && (
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <h3 className="text-sm font-semibold text-gray-900 mb-4">Pre-Enrichment Signals (Free)</h3>
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                <Field label="Email domain type" value={
                  s.email_domain_type
                    ? <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${DOMAIN_BADGE[s.email_domain_type]?.cls}`}>
                        {DOMAIN_BADGE[s.email_domain_type]?.label}
                      </span>
                    : null
                } />
                <Field label="Institution (normalized)" value={s.institution_name_normalized} />
                <Field label="Institution domain" value={s.institution_domain_verified} mono />
                <Field label="Institution country" value={s.institution_country_normalized} />
                <Field label="Enrichment priority" value={s.enrichment_priority > 0 ? String(s.enrichment_priority) : null} mono />
              </dl>
            </div>
          )}
        </div>
      )}

      {/* ── Tab 4: Cases ───────────────────────────────────────────────────────── */}
      {active === 4 && (
        <div>
          {cases.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-sm text-gray-400">
              No cases for this subscriber.
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100">
                    {['Opened', 'Status', 'Decision', 'Decided'].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wide">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {cases.map(c => (
                    <tr key={c.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <Link href={`/dashboard/cases/${c.id}`} className="text-gray-900 hover:underline">
                          {new Date(c.opened_at).toLocaleDateString('en-GB')}
                        </Link>
                      </td>
                      <td className="px-4 py-3 capitalize text-gray-700">{c.status.replace(/_/g, ' ')}</td>
                      <td className="px-4 py-3 capitalize text-gray-700">{c.decision.replace(/_/g, ' ')}</td>
                      <td className="px-4 py-3 text-gray-400">{c.decided_at ? new Date(c.decided_at).toLocaleDateString('en-GB') : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Tab 5: Timeline ────────────────────────────────────────────────────── */}
      {active === 5 && (
        <div>
          {auditLog.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-sm text-gray-400">
              No audit log entries for this subscriber.
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="divide-y divide-gray-50">
                {auditLog.map(e => (
                  <div key={e.id} className="px-4 py-3 flex items-start gap-3">
                    <div className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-gray-300 mt-2" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-xs text-gray-700">{e.action}</span>
                        <span className="text-xs text-gray-400 capitalize">{e.actor_type}</span>
                      </div>
                      {e.metadata && (
                        <div className="text-xs text-gray-400 mt-0.5 truncate max-w-sm">
                          {Object.entries(e.metadata).map(([k, v]) => `${k}: ${v}`).join(' · ')}
                        </div>
                      )}
                    </div>
                    <div className="flex-shrink-0 text-xs text-gray-400 whitespace-nowrap">
                      {new Date(e.created_at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
