import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { AssignButton } from '@/components/cases/assign-button'

interface PageProps {
  searchParams: { status?: string; tier?: string; page?: string }
}

type CaseRow = {
  id: string
  opened_at: string
  status: string
  decision: string
  assigned_to: string | null
  subscribers: { id: string; name: string | null; email: string } | null
  subscriber_scores: { total_score: number; confidence_tier: number; tier_label: string } | null
}

const STATUS_LABELS: Record<string, string> = {
  pending_review: 'Pending Review',
  in_review: 'In Review',
  approved_for_outreach: 'Approved',
  dismissed: 'Dismissed',
  resolved: 'Resolved',
}

const STATUS_COLORS: Record<string, string> = {
  pending_review: 'bg-yellow-100 text-yellow-700',
  in_review: 'bg-blue-100 text-blue-700',
  approved_for_outreach: 'bg-green-100 text-green-700',
  dismissed: 'bg-gray-100 text-gray-500',
  resolved: 'bg-gray-100 text-gray-500',
}

export default async function CasesPage({ searchParams }: PageProps) {
  const supabase = await createClient()
  const statusFilter = searchParams.status ?? ''
  const tierFilter = searchParams.tier ?? ''
  const page = Math.max(1, parseInt(searchParams.page ?? '1', 10))
  const pageSize = 50

  let query = supabase
    .from('cases')
    .select('id, opened_at, status, decision, assigned_to, subscribers!inner(id, name, email), subscriber_scores!inner(total_score, confidence_tier, tier_label)', { count: 'exact' })
    .order('opened_at', { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1)

  if (statusFilter) query = query.eq('status', statusFilter)

  const { data, count } = await (query as unknown as Promise<{ data: CaseRow[] | null; count: number | null }>)

  let rows = data ?? []
  if (tierFilter) rows = rows.filter(c => String(c.subscriber_scores?.confidence_tier ?? '') === tierFilter)

  const totalPages = Math.ceil((count ?? 0) / pageSize)
  const qs = (extra?: Record<string, string>) => {
    const p: Record<string, string> = {}
    if (statusFilter) p.status = statusFilter
    if (tierFilter) p.tier = tierFilter
    Object.assign(p, extra)
    const s = new URLSearchParams(p).toString()
    return s ? `?${s}` : ''
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Cases</h1>
          <p className="mt-1 text-sm text-gray-500">{count ?? 0} total</p>
        </div>
      </div>

      {/* Filters */}
      <form action="/dashboard/cases" method="GET" className="flex flex-wrap gap-3 mb-4">
        <select name="status" defaultValue={statusFilter}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500">
          <option value="">All Statuses</option>
          <option value="pending_review">Pending Review</option>
          <option value="in_review">In Review</option>
          <option value="approved_for_outreach">Approved</option>
          <option value="dismissed">Dismissed</option>
        </select>
        <select name="tier" defaultValue={tierFilter}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500">
          <option value="">All Tiers</option>
          <option value="1">Tier 1</option>
          <option value="2">Tier 2</option>
          <option value="3">Tier 3</option>
        </select>
        <button type="submit"
          className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50">
          Apply
        </button>
        {(statusFilter || tierFilter) && (
          <Link href="/dashboard/cases" className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700">Clear</Link>
        )}
      </form>

      {rows.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <p className="text-sm text-gray-500">
            {statusFilter || tierFilter
              ? 'No cases match your filters.'
              : 'No cases yet. Cases are created automatically after a scoring run for Tier 1 and Tier 2 subscribers.'}
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {['Subscriber', 'Tier', 'Score', 'Status', 'Opened', 'Assigned To', ''].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map(c => (
                  <tr key={c.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <Link href={`/dashboard/cases/${c.id}`} className="hover:text-brand-600">
                        <div className="font-medium text-gray-900">{c.subscribers?.name ?? '—'}</div>
                        <div className="text-xs text-gray-500">{c.subscribers?.email}</div>
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      {c.subscriber_scores ? (
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                          c.subscriber_scores.confidence_tier === 1 ? 'bg-red-100 text-red-700' :
                          c.subscriber_scores.confidence_tier === 2 ? 'bg-orange-100 text-orange-700' :
                          'bg-yellow-100 text-yellow-700'
                        }`}>
                          Tier {c.subscriber_scores.confidence_tier}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3 font-mono font-semibold text-gray-900">
                      {c.subscriber_scores?.total_score ?? '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[c.status] ?? 'bg-gray-100 text-gray-500'}`}>
                        {STATUS_LABELS[c.status] ?? c.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                      {new Date(c.opened_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {c.assigned_to ? 'Assigned' : <span className="text-gray-400">Unassigned</span>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <Link href={`/dashboard/cases/${c.id}`}
                          className="text-xs text-brand-600 hover:text-brand-800 font-medium whitespace-nowrap">
                          Review →
                        </Link>
                        {!c.assigned_to && <AssignButton caseId={c.id} />}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="px-4 py-3 border-t border-gray-200 flex justify-between text-sm text-gray-600">
              <span>Page {page} of {totalPages}</span>
              <div className="flex gap-2">
                {page > 1 && <Link href={`/dashboard/cases${qs({ page: String(page - 1) })}`} className="px-3 py-1 border rounded hover:bg-gray-50">← Prev</Link>}
                {page < totalPages && <Link href={`/dashboard/cases${qs({ page: String(page + 1) })}`} className="px-3 py-1 border rounded hover:bg-gray-50">Next →</Link>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}