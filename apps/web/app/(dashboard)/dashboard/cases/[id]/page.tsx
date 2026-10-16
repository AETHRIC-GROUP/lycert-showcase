import { notFound } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { CaseDecisionForm } from './decision-form'
import { CaseComments } from '@/components/cases/case-comments'
import { LIFECYCLE_LABELS, LIFECYCLE_COLORS, type LifecycleStage } from '@/lib/utils/lifecycle'

interface PageProps { params: { id: string } }

const STATUS_LABELS: Record<string, string> = {
  pending_review: 'Pending Review', in_review: 'In Review',
  approved_for_outreach: 'Approved for Outreach', dismissed: 'Dismissed', resolved: 'Resolved',
}

export default async function CaseDetailPage({ params }: PageProps) {
  const supabase = await createClient()

  const { data: authData } = await supabase.auth.getUser()
  if (!authData.user) notFound()

  const { data: tuData } = (await supabase
    .from('tenant_users').select('id, tenant_id, role')
    .eq('user_id', authData.user.id).maybeSingle()
  ) as unknown as { data: { id: string; tenant_id: string; role: string } | null }

  const { data: caseData } = (await supabase
    .from('cases').select('*').eq('id', params.id).maybeSingle()
  ) as unknown as { data: Record<string, unknown> | null }

  if (!caseData) notFound()

  const [subRes, scoreRes, commentsRes] = await Promise.all([
    (supabase.from('subscribers').select('*').eq('id', caseData.subscriber_id as string).maybeSingle()) as unknown as Promise<{ data: Record<string, unknown> | null }>,
    (supabase.from('subscriber_scores').select('*').eq('id', caseData.score_id as string).maybeSingle()) as unknown as Promise<{ data: Record<string, unknown> | null }>,
    (supabase.from('case_comments').select('id, body, created_at, tenant_users!inner(display_name, email)').eq('case_id', params.id).order('created_at')) as unknown as Promise<{ data: Record<string, unknown>[] | null }>,
  ])

  const sub = subRes.data
  const score = scoreRes.data
  const rawComments = commentsRes.data ?? []

  const comments = rawComments.map((c: any) => ({
    id: c.id as string,
    body: c.body as string,
    created_at: c.created_at as string,
    author: (c.tenant_users as any)?.display_name ?? (c.tenant_users as any)?.email ?? 'Team member',
  }))

  const signals = score?.signals_fired
    ? (score.signals_fired as string).split(',').filter(Boolean)
    : []

  return (
    <div className="max-w-4xl">
      <div className="mb-4">
        <Link href="/dashboard/cases" className="text-sm text-brand-600 hover:underline">← All cases</Link>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {sub?.name as string ?? 'Subscriber'}
          </h1>
          <p className="text-sm text-gray-500 mt-1">{sub?.email as string}</p>
        </div>
        <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${
          caseData.status === 'pending_review' ? 'bg-yellow-100 text-yellow-700' :
          caseData.status === 'in_review' ? 'bg-blue-100 text-blue-700' :
          caseData.status === 'approved_for_outreach' ? 'bg-green-100 text-green-700' :
          'bg-gray-100 text-gray-500'
        }`}>
          {STATUS_LABELS[caseData.status as string] ?? caseData.status as string}
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Left: subscriber summary + score */}
        <div className="lg:col-span-2 space-y-5">

          {/* Subscriber summary */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h2 className="text-sm font-semibold text-gray-700 mb-4">Subscriber Profile</h2>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              {[
                ['Email', sub?.email],
                ['Institution', sub?.institution_name],
                ['Graduation date', sub?.stated_graduation_date
                  ? new Date(sub.stated_graduation_date as string).toLocaleDateString('en-GB', { year: 'numeric', month: 'long' })
                  : null],
                ['Country', sub?.account_country],
                ['Plan', sub?.plan_name],
                ['Stage', sub?.lifecycle_stage
                  ? (LIFECYCLE_LABELS[sub.lifecycle_stage as LifecycleStage] ?? sub.lifecycle_stage as string)
                  : null],
              ].map(([label, value]) => (
                <div key={label as string}>
                  <dt className="text-xs text-gray-500 uppercase tracking-wide">{label as string}</dt>
                  <dd className="mt-0.5 text-gray-900 font-medium">{(value as string) ?? '—'}</dd>
                </div>
              ))}
            </dl>
          </div>

          {/* Score breakdown */}
          {score && (
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <h2 className="text-sm font-semibold text-gray-700 mb-4">Score Breakdown</h2>
              <div className="flex items-center gap-4 mb-4">
                <div className="text-4xl font-bold text-gray-900">{score.total_score as number}</div>
                <div>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                    (score.confidence_tier as number) === 1 ? 'bg-red-100 text-red-700' :
                    (score.confidence_tier as number) === 2 ? 'bg-orange-100 text-orange-700' :
                    'bg-yellow-100 text-yellow-700'
                  }`}>
                    {score.tier_label as string}
                  </span>
                  <div className="text-xs text-gray-500 mt-1">Confidence: {score.data_confidence as string}</div>
                </div>
              </div>

              {Boolean(score.primary_signal) && (
                <div className="mb-3">
                  <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Primary Signal</div>
                  <p className="text-sm text-gray-800">{score.primary_signal as string}</p>
                </div>
              )}

              {signals.length > 0 && (
                <div className="mb-3">
                  <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Signals Fired</div>
                  <div className="flex flex-wrap gap-1">
                    {signals.map(s => (
                      <span key={s} className="inline-flex items-center px-2 py-0.5 rounded bg-gray-100 text-gray-700 text-xs font-mono">
                        {s.trim()}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {Boolean(score.data_gaps) && (score.data_gaps as string).length > 0 && (
                <div className="mb-3">
                  <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Data Gaps</div>
                  <p className="text-xs text-gray-500">{score.data_gaps as string}</p>
                </div>
              )}

              {Boolean(score.ai_explanation) && (
                <div>
                  <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">AI Explanation</div>
                  <p className="text-sm text-gray-700 bg-gray-50 rounded-lg px-3 py-2">{score.ai_explanation as string}</p>
                </div>
              )}

              {Boolean(score.aec_professional_confirmed) && (
                <div className="mt-3 flex items-center gap-2 text-red-600 text-sm font-medium">
                  <span>⚠</span> AEC Professional Confirmed
                </div>
              )}
            </div>
          )}

          {/* Decision form */}
          <CaseDecisionForm
            caseId={params.id}
            currentStatus={caseData.status as string}
            currentDecision={caseData.decision as string}
            decisionNote={(caseData.decision_note as string) ?? ''}
          />

          {/* Comments */}
          {tuData && (
            <CaseComments
              caseId={params.id}
              tenantId={tuData.tenant_id}
              authorId={tuData.id}
              initialComments={comments}
            />
          )}
        </div>

        {/* Right: case meta */}
        <div className="space-y-5">
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h2 className="text-sm font-semibold text-gray-700 mb-4">Case Info</h2>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-xs text-gray-500 uppercase tracking-wide">Opened</dt>
                <dd className="mt-0.5 text-gray-900">
                  {new Date(caseData.opened_at as string).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                </dd>
              </div>
              {Boolean(caseData.decided_at) && (
                <div>
                  <dt className="text-xs text-gray-500 uppercase tracking-wide">Decided</dt>
                  <dd className="mt-0.5 text-gray-900">
                    {new Date(caseData.decided_at as string).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                  </dd>
                </div>
              )}
              {caseData.review_duration_seconds != null && (
                <div>
                  <dt className="text-xs text-gray-500 uppercase tracking-wide">Review Duration</dt>
                  <dd className="mt-0.5 text-gray-900">{caseData.review_duration_seconds as number}s</dd>
                </div>
              )}
              {Boolean(caseData.decision_note) && (
                <div>
                  <dt className="text-xs text-gray-500 uppercase tracking-wide">Decision Note</dt>
                  <dd className="mt-0.5 text-gray-700 text-xs">{caseData.decision_note as string}</dd>
                </div>
              )}
              <div>
                <dt className="text-xs text-gray-500 uppercase tracking-wide">Subscriber</dt>
                <dd className="mt-0.5">
                  <Link href={`/dashboard/subscribers/${caseData.subscriber_id as string}`}
                    className="text-brand-600 hover:underline text-xs">
                    View full profile →
                  </Link>
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </div>
  )
}