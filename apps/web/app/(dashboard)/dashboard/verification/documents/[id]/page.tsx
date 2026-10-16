import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { DocumentReviewPanel } from '@/components/verification/document-review-panel'

// Reviewer screen (LYCERT_DOCUMENT_REVIEW_ARCHITECTURE.md Part 7): extracted minimal fields, the
// assistance flags as plain-language reasons, the tamper score, the cross-reference match set, the
// machine recommendation, and approve/reject/needs-more with a MANDATORY decision note. The raw
// document is viewable only via a time-boxed signed URL while the processing window is open.

export const dynamic = 'force-dynamic'

type Row = Record<string, unknown>

const FLAG_EXPLANATIONS: Array<{ key: string; text: string }> = [
  { key: 'flag_font_anomaly', text: 'Font or kerning inconsistency detected — text may have been substituted' },
  { key: 'flag_template_deviation', text: 'Layout deviates from the expected template for this document type' },
  { key: 'flag_metadata_anomaly', text: 'File metadata is inconsistent (possible digital editing)' },
  { key: 'flag_copy_move', text: 'Cloned regions detected within the image (copy-move forgery pattern)' },
  { key: 'flag_composite', text: 'Image appears composited from multiple fragments' },
  { key: 'flag_color_inconsistency', text: 'Color alignment differs across regions of the document' },
  { key: 'flag_repeat_document', text: 'This exact document was already submitted by another applicant' },
]

const RECOMMENDATION_TEXT: Record<string, string> = {
  enrolled_medium: 'The machine read supports enrollment at MEDIUM confidence — all cross-reference checks matched and no forensic flags fired. A human decision is still required.',
  inconclusive: 'The machine could not corroborate enrollment from this document alone. Review the fields and the document image before deciding.',
  suspected_tamper: 'One or more forensic assistance flags fired. This is NOT proof of fraud — inspect the document and decide; a rejection never auto-actions the subscriber.',
}

function XrefBadge({ value }: { value: boolean | null }) {
  if (value === true) return <span className="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">match</span>
  if (value === false) return <span className="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">mismatch</span>
  return <span className="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-500">unknown</span>
}

export default async function DocumentReviewDetailPage({ params }: { params: { id: string } }) {
  const supabase = await createClient()
  const { data } = await supabase
    .from('verification_documents')
    .select('*, subscribers!inner(id, name, email, institution_name, stated_graduation_date)')
    .eq('id', params.id)
    .maybeSingle()
  if (!data) notFound()
  const d = data as unknown as Row
  const sub = (d.subscribers ?? {}) as Row

  const firedFlags = FLAG_EXPLANATIONS.filter(f => d[f.key] === true)
  const decided = d.review_status === 'decided'
  const viewable = !!d.transient_storage_ref && !d.purged_at && !decided

  const extracted: Array<[string, unknown]> = [
    ['Name on document', d.extracted_name],
    ['Institution on document', d.extracted_institution],
    ['Enrollment status', d.extracted_enrollment_status],
    ['Enrollment end', d.extracted_enrollment_end],
    ['Document issue date', d.extracted_doc_issue_date],
    ['Age eligible', d.age_eligible == null ? null : d.age_eligible ? 'yes' : 'no'],
  ]

  return (
    <div className="max-w-4xl">
      <Link href="/dashboard/verification/documents" className="text-sm text-brand-600 hover:text-brand-800">← Document Review</Link>

      <div className="mt-4 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{(sub.name as string) ?? 'Subscriber'}</h1>
          <p className="mt-1 text-sm text-gray-500">{sub.email as string}</p>
        </div>
        <div className="text-right text-xs text-gray-500">
          <div>Uploaded {new Date(String(d.created_at)).toLocaleString('en-GB')}</div>
          <div className="mt-1">Document type: <span className="font-medium text-gray-700">{String(d.doc_type ?? 'unknown')}</span></div>
        </div>
      </div>

      {/* Machine recommendation */}
      <div className={`mt-6 rounded-xl border p-4 ${
        d.machine_recommendation === 'suspected_tamper' ? 'border-red-200 bg-red-50' :
        d.machine_recommendation === 'enrolled_medium' ? 'border-green-200 bg-green-50' :
        'border-yellow-200 bg-yellow-50'}`}>
        <div className="text-sm font-semibold text-gray-900">
          Machine recommendation: {String(d.machine_recommendation ?? 'none')} · confidence capped at MEDIUM
        </div>
        <p className="mt-1 text-sm text-gray-700">
          {RECOMMENDATION_TEXT[String(d.machine_recommendation)] ?? 'No machine read available — decide from the document image and the subscriber claim.'}
        </p>
        <p className="mt-2 text-xs text-gray-500">
          Physical security features cannot be checked on an uploaded image — this is a permanent limitation
          of image-based review, which is why a document can never exceed MEDIUM confidence.
        </p>
      </div>

      <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Extracted fields vs claim */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">Extracted fields (minimal set)</h2>
          <dl className="space-y-2 text-sm">
            {extracted.map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4">
                <dt className="text-gray-500">{label}</dt>
                <dd className="text-gray-900 text-right">{value != null && value !== '' ? String(value) : <span className="text-gray-400">not read</span>}</dd>
              </div>
            ))}
          </dl>
          <h3 className="mt-5 text-sm font-semibold text-gray-900 mb-2">Subscriber claim</h3>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-4"><dt className="text-gray-500">Name</dt><dd className="text-gray-900">{(sub.name as string) ?? '—'}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-gray-500">Institution</dt><dd className="text-gray-900">{(sub.institution_name as string) ?? '—'}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-gray-500">Stated graduation</dt><dd className="text-gray-900">{(sub.stated_graduation_date as string) ?? '—'}</dd></div>
          </dl>
        </div>

        {/* Cross-reference + forensic flags */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">Cross-reference checks</h2>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-4"><dt className="text-gray-500">Institution is real (trust DB)</dt><dd><XrefBadge value={d.xref_institution_real as boolean | null} /></dd></div>
            <div className="flex justify-between gap-4"><dt className="text-gray-500">Name matches claim</dt><dd><XrefBadge value={d.xref_name_matches_claim as boolean | null} /></dd></div>
            <div className="flex justify-between gap-4"><dt className="text-gray-500">Institution matches claim</dt><dd><XrefBadge value={d.xref_institution_matches_claim as boolean | null} /></dd></div>
            <div className="flex justify-between gap-4"><dt className="text-gray-500">Dates consistent</dt><dd><XrefBadge value={d.xref_dates_consistent as boolean | null} /></dd></div>
          </dl>

          <h2 className="mt-5 text-sm font-semibold text-gray-900 mb-2">
            Forensic assistance flags
            <span className="ml-2 font-normal text-xs text-gray-500">tamper score: {d.tamper_risk_score != null ? Number(d.tamper_risk_score).toFixed(2) : '—'}</span>
          </h2>
          {firedFlags.length === 0 ? (
            <p className="text-sm text-gray-500">No forensic flags fired.</p>
          ) : (
            <ul className="space-y-1.5 text-sm text-red-700 list-disc pl-5">
              {firedFlags.map(f => <li key={f.key}>{f.text}</li>)}
            </ul>
          )}
        </div>
      </div>

      {/* Decision panel (client) */}
      <div className="mt-6">
        <DocumentReviewPanel
          documentId={String(d.id)}
          decided={decided}
          reviewerDecision={(d.reviewer_decision as string | null) ?? null}
          reviewerDecidedAt={(d.reviewer_decided_at as string | null) ?? null}
          viewable={viewable}
          purged={!!d.purged_at}
        />
      </div>
    </div>
  )
}
