'use client'

import { useState } from 'react'

type LifecycleResult = {
  evaluated: number
  updated: number
  job_date: string
}

export function LifecycleCard() {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<LifecycleResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function runNow() {
    setLoading(true)
    setResult(null)
    setError(null)
    try {
      const res = await fetch('/api/lifecycle/run', { method: 'POST' })
      const json = await res.json() as { evaluated?: number; updated?: number; job_date?: string; error?: string }
      if (!res.ok) {
        setError(json.error ?? 'Lifecycle engine failed.')
        return
      }
      setResult({
        evaluated: json.evaluated ?? 0,
        updated: json.updated ?? 0,
        job_date: json.job_date ?? new Date().toISOString().slice(0, 10),
      })
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-gray-700">Lifecycle Engine</h2>
          <p className="mt-1 text-xs text-gray-500 max-w-lg">
            Runs nightly at 02:00 UTC. Updates subscriber stages (Active Student → Approaching Graduation → Post-Graduation)
            based on graduation dates. Use &ldquo;Run now&rdquo; to apply immediately after a CSV import or data correction.
          </p>
        </div>
        <button
          onClick={runNow}
          disabled={loading}
          className="flex-shrink-0 px-4 py-2 bg-gray-800 text-white text-sm font-medium rounded-lg hover:bg-gray-900 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? 'Running…' : 'Run now'}
        </button>
      </div>

      {result && (
        <div className="mt-5 flex gap-8 border-t border-gray-100 pt-4">
          <div>
            <div className="text-2xl font-bold text-gray-900">{result.evaluated.toLocaleString()}</div>
            <div className="text-xs text-gray-500 mt-0.5">subscribers evaluated</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-brand-600">{result.updated.toLocaleString()}</div>
            <div className="text-xs text-gray-500 mt-0.5">stages updated</div>
          </div>
          <div className="flex items-end pb-1">
            <span className="text-xs text-gray-400">run date: {result.job_date}</span>
          </div>
        </div>
      )}

      {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
    </div>
  )
}
