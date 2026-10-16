'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// Human-in-the-loop decision panel (LYCERT_DOCUMENT_REVIEW_ARCHITECTURE.md Part 7).
// - "View document" mints a time-boxed signed URL (audited server-side) and renders it inline —
//   view-only during the processing window; gone once decided or purged.
// - approve / reject / needs-more all REQUIRE a decision note.
// - A rejection never auto-actions the subscriber (adverse steps go through the notice+appeal gate).

interface Props {
  documentId: string
  decided: boolean
  reviewerDecision: string | null
  reviewerDecidedAt: string | null
  viewable: boolean
  purged: boolean
}

export function DocumentReviewPanel({ documentId, decided, reviewerDecision, reviewerDecidedAt, viewable, purged }: Props) {
  const router = useRouter()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [viewUrl, setViewUrl] = useState<string | null>(null)

  async function viewDocument() {
    setBusy('view'); setError(null)
    try {
      const res = await fetch('/api/verification/document/view', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      setViewUrl(json.url as string)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function decide(decision: 'approved' | 'rejected' | 'needs_more') {
    if (!note.trim()) { setError('A decision note is required.'); return }
    if (decision === 'rejected' && !window.confirm('Reject this document? The subscriber remains UNVERIFIED (a document can never prove non-enrollment); any adverse action still requires the separate human notice + appeal process.')) return
    setBusy(decision); setError(null)
    try {
      const res = await fetch('/api/verification/document/review', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId, decision, note: note.trim() }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  if (decided) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="text-sm font-semibold text-gray-900">Decision recorded</h2>
        <p className="mt-1 text-sm text-gray-700">
          <span className="font-medium capitalize">{reviewerDecision ?? '—'}</span>
          {reviewerDecidedAt ? ` · ${new Date(reviewerDecidedAt).toLocaleString('en-GB')}` : ''}
        </p>
        <p className="mt-2 text-xs text-gray-500">
          The raw document {purged ? 'has been destroyed' : 'is queued for destruction'} per process-and-purge.
          Only the extracted fields and this decision are retained.
        </p>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <h2 className="text-sm font-semibold text-gray-900 mb-3">Your decision</h2>

      {viewable ? (
        <div className="mb-4">
          {viewUrl ? (
            <div>
              <iframe src={viewUrl} className="w-full h-96 rounded-lg border border-gray-200" title="Document (view-only, expiring link)" />
              <p className="mt-1 text-xs text-gray-500">View-only link — expires in 10 minutes and is audit-logged.</p>
            </div>
          ) : (
            <button onClick={viewDocument} disabled={busy === 'view'}
              className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50">
              {busy === 'view' ? 'Opening…' : 'View document (audited)'}
            </button>
          )}
        </div>
      ) : (
        <p className="mb-4 text-xs text-gray-500">
          The raw document is no longer viewable{purged ? ' (destroyed per process-and-purge)' : ''} — decide from the extracted fields, or request a re-upload via “Needs more”.
        </p>
      )}

      <label className="block text-xs font-medium text-gray-700 mb-1">Decision note (required)</label>
      <textarea value={note} onChange={e => setNote(e.target.value)} rows={3}
        placeholder="Why you are approving / rejecting / requesting more — recorded in the audit log"
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <div className="mt-4 flex flex-wrap gap-3">
        <button onClick={() => decide('approved')} disabled={!!busy}
          className="px-4 py-2 rounded-lg text-sm font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-50">
          {busy === 'approved' ? 'Saving…' : 'Approve (enrolled · medium)'}
        </button>
        <button onClick={() => decide('rejected')} disabled={!!busy}
          className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-50">
          {busy === 'rejected' ? 'Saving…' : 'Reject (stays unverified)'}
        </button>
        <button onClick={() => decide('needs_more')} disabled={!!busy}
          className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50">
          {busy === 'needs_more' ? 'Saving…' : 'Needs more'}
        </button>
      </div>
      <p className="mt-3 text-xs text-gray-500">
        Approving records enrollment at MEDIUM confidence (never higher — image-based review). Rejecting can
        never mark a subscriber as not enrolled; it leaves them unverified.
      </p>
    </div>
  )
}
