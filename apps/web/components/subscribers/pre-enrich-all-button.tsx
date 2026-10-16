'use client'

import { useState } from 'react'

export function PreEnrichAllButton() {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  async function handleClick() {
    setLoading(true)
    setResult(null)
    const res = await fetch('/api/pre-enrich/batch', { method: 'POST' })
    const body = await res.json()
    setLoading(false)
    if (!res.ok) {
      setResult(body.error ?? 'Failed')
      return
    }
    const { total, updated, errors } = body
    if (total === 0) {
      setResult('All subscribers already classified')
    } else {
      setResult(`Classified ${updated}/${total}${errors > 0 ? ` (${errors} errors)` : ''} — refresh to see`)
    }
  }

  return (
    <div className="flex items-center gap-2">
      {result && <span className="text-xs text-gray-400 max-w-xs truncate" title={result}>{result}</span>}
      <button
        onClick={handleClick}
        disabled={loading}
        title="Free — classifies email domains and scores enrichment priority for all subscribers"
        className="px-3 py-1.5 bg-white border border-gray-200 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
      >
        {loading ? 'Running…' : 'Pre-Enrich All'}
      </button>
    </div>
  )
}
