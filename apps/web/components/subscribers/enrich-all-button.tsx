'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Triggers the V2 durable enrichment pipeline (ZeroBounce gate → Hunter → PDL → FullEnrich async),
 * via POST /api/enrichment/enqueue. This returns immediately ({ jobId, enqueued }); the pg_cron
 * workers process the queue in the background. We dispatch `lycert:enrich-started` so the
 * EnrichmentActivityBar starts auto-refreshing, and refresh once so any already-cached rows update.
 */
export function EnrichAllButton() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  async function handleEnrichAll() {
    setLoading(true)
    setResult(null)
    try {
      const res = await fetch('/api/enrichment/enqueue', { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setResult(body.error ?? 'Failed to queue enrichment')
        return
      }
      const n = body.enqueued ?? 0
      if (n === 0) {
        setResult('No subscribers to enrich')
      } else {
        setResult(`Queued ${n} — enriching in the background`)
        // Kick the activity bar into live-refresh mode and pull any immediate changes.
        window.dispatchEvent(new CustomEvent('lycert:enrich-started'))
        router.refresh()
      }
    } catch {
      setResult('Failed to queue enrichment')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      {result && <span className="text-xs text-gray-400 max-w-xs truncate" title={result}>{result}</span>}
      <button
        onClick={handleEnrichAll}
        disabled={loading}
        className="px-3 py-1.5 bg-violet-600 text-white text-sm font-medium rounded-lg hover:bg-violet-700 disabled:opacity-50 transition-colors"
      >
        {loading ? 'Queuing…' : 'Enrich All'}
      </button>
    </div>
  )
}
