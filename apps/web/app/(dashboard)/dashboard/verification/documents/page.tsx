import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'

// Document review queue (LYCERT_DOCUMENT_REVIEW_ARCHITECTURE.md Part 7). Every document that reaches
// Step 5 lands here for a HUMAN decision — the machine only annotates (Part 1.2, no auto-approval).
// Empty until the Part 9 gate opens (upload is off by default), but fully operable for review.

interface PageProps {
  searchParams: { status?: string; page?: string }
}

type DocRow = {
  id: string
  created_at: string
  doc_type: string | null
  machine_recommendation: string | null
  tamper_risk_score: number | null
  review_status: string
  reviewer_decision: string | null
  purged_at: string | null
  subscribers: { id: string; name: string | null; email: string } | null
}

const RECOMMENDATION_LABELS: Record<string, string> = {
  enrolled_medium: 'Looks enrolled (medium)',
  inconclusive: 'Inconclusive',
  suspected_tamper: 'Suspected tamper',
}
const RECOMMENDATION_COLORS: Record<string, string> = {
  enrolled_medium: 'bg-green-100 text-green-700',
  inconclusive: 'bg-yellow-100 text-yellow-700',
  suspected_tamper: 'bg-red-100 text-red-700',
}
const STATUS_LABELS: Record<string, string> = {
  pending_ocr: 'Processing',
  pending_review: 'Pending Review',
  decided: 'Decided',
}
const DOC_TYPE_LABELS: Record<string, string> = {
  student_id: 'Student ID',
  enrollment_cert: 'Enrollment certificate',
  tuition_bill: 'Tuition bill',
  unknown: 'Unknown',
}

export default async function DocumentReviewQueuePage({ searchParams }: PageProps) {
  const supabase = await createClient()
  const statusFilter = searchParams.status ?? 'pending_review'
  const page = Math.max(1, parseInt(searchParams.page ?? '1', 10))
  const pageSize = 50

  let query = supabase
    .from('verification_documents')
    .select('id, created_at, doc_type, machine_recommendation, tamper_risk_score, review_status, reviewer_decision, purged_at, subscribers!inner(id, name, email)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1)
  if (statusFilter) query = query.eq('review_status', statusFilter)

  const { data, count } = await (query as unknown as Promise<{ data: DocRow[] | null; count: number | null }>)
  const rows = data ?? []
  const totalPages = Math.ceil((count ?? 0) / pageSize)

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Document Review</h1>
          <p className="mt-1 text-sm text-gray-500">
            {count ?? 0} document{(count ?? 0) === 1 ? '' : 's'} · every document requires a human decision —
            machine output is assistance only, capped at medium confidence
          </p>
        </div>
      </div>

      <form action="/dashboard/verification/documents" method="GET" className="flex flex-wrap gap-3 mb-4">
        <select name="status" defaultValue={statusFilter}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500">
          <option value="pending_review">Pending Review</option>
          <option value="pending_ocr">Processing</option>
          <option value="decided">Decided</option>
          <option value="">All</option>
        </select>
        <button type="submit"
          className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50">
          Apply
        </button>
      </form>

      {rows.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <p className="text-sm text-gray-500">
            {statusFilter === 'pending_review'
              ? 'No documents awaiting review. Documents appear here after a subscriber uploads enrollment proof (document upload is currently gated off by default).'
              : 'No documents match this filter.'}
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {['Subscriber', 'Document', 'Machine read', 'Tamper score', 'Status', 'Uploaded', ''].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map(r => (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">{r.subscribers?.name ?? '—'}</div>
                      <div className="text-xs text-gray-500">{r.subscribers?.email}</div>
                    </td>
                    <td className="px-4 py-3 text-gray-700">{DOC_TYPE_LABELS[r.doc_type ?? 'unknown'] ?? r.doc_type}</td>
                    <td className="px-4 py-3">
                      {r.machine_recommendation ? (
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${RECOMMENDATION_COLORS[r.machine_recommendation] ?? 'bg-gray-100 text-gray-500'}`}>
                          {RECOMMENDATION_LABELS[r.machine_recommendation] ?? r.machine_recommendation}
                        </span>
                      ) : <span className="text-xs text-gray-400">—</span>}
                    </td>
                    <td className="px-4 py-3 font-mono text-gray-900">
                      {r.tamper_risk_score != null ? Number(r.tamper_risk_score).toFixed(2) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        r.review_status === 'pending_review' ? 'bg-yellow-100 text-yellow-700' :
                        r.review_status === 'decided'
                          ? (r.reviewer_decision === 'approved' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500')
                          : 'bg-blue-100 text-blue-700'
                      }`}>
                        {STATUS_LABELS[r.review_status] ?? r.review_status}
                        {r.review_status === 'decided' && r.reviewer_decision ? ` · ${r.reviewer_decision}` : ''}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                      {new Date(r.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </td>
                    <td className="px-4 py-3">
                      <Link href={`/dashboard/verification/documents/${r.id}`}
                        className="text-xs text-brand-600 hover:text-brand-800 font-medium whitespace-nowrap">
                        Review →
                      </Link>
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
                {page > 1 && <Link href={`/dashboard/verification/documents?status=${statusFilter}&page=${page - 1}`} className="px-3 py-1 border rounded hover:bg-gray-50">← Prev</Link>}
                {page < totalPages && <Link href={`/dashboard/verification/documents?status=${statusFilter}&page=${page + 1}`} className="px-3 py-1 border rounded hover:bg-gray-50">Next →</Link>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
