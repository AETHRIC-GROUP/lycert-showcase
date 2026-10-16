'use client'

import { useEffect, useRef, useState } from 'react'
import { submitCaseDecisionAction } from '@/lib/actions/case-decision'
import { createClient } from '@/lib/supabase/client'

interface Props {
  caseId: string
  currentStatus: string
  currentDecision: string
  decisionNote: string
}

export function CaseDecisionForm({ caseId, currentStatus, currentDecision, decisionNote }: Props) {
  const openedAt = useRef(Date.now())
  const [decision, setDecision] = useState(currentDecision)
  const [note, setNote] = useState(decisionNote)
  const [warning, setWarning] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Record reviewed_at immediately when the reviewer opens the case (browser-side, non-blocking)
  useEffect(() => {
    const supabase = createClient()
    void (supabase.from('cases') as any)
      .update({ reviewed_at: new Date().toISOString() })
      .eq('id', caseId)
  }, [caseId])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    const durationSeconds = Math.round((Date.now() - openedAt.current) / 1000)

    if (durationSeconds < 10 && !warning) {
      setWarning(true)
      return
    }

    if (note.trim().length < 20) {
      setError('Decision note must be at least 20 characters.')
      return
    }

    setSaving(true)
    const result = await submitCaseDecisionAction(caseId, decision, note.trim(), durationSeconds)
    setSaving(false)

    if (result.error) {
      setError('Failed to save decision. Please try again.')
    }
  }

  if (currentStatus === 'resolved' || currentStatus === 'dismissed') return null

  return (
    <form onSubmit={handleSubmit} className="mt-5 bg-white rounded-xl border border-gray-200 p-5">
      <h2 className="text-sm font-semibold text-gray-700 mb-4">Decision</h2>

      {warning && (
        <div className="mb-4 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800">
          This review was completed in less than 10 seconds. Please confirm you have reviewed the
          subscriber&apos;s full profile before proceeding.
        </div>
      )}

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Decision</label>
          <select
            value={decision}
            onChange={e => setDecision(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="pending">— Select a decision —</option>
            <option value="proceed_outreach">Approved for Outreach</option>
            <option value="dismiss_false_positive">Dismiss (False Positive)</option>
            <option value="escalate">Escalate for Review</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Decision note <span className="text-red-500">*</span>
          </label>
          <textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            rows={4}
            required
            placeholder="Explain your reasoning (minimum 20 characters)…"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <p className="text-xs text-gray-400 mt-1">{note.length} / 20 min characters</p>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={saving || decision === 'pending'}
          className="px-4 py-2 bg-brand-600 text-white text-sm font-medium rounded-lg hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? 'Saving…' : warning ? 'Confirm Decision Anyway' : 'Confirm Decision'}
        </button>
      </div>
    </form>
  )
}
