'use client'

import { useEffect, useState } from 'react'

type Provider = {
  providerKey: string
  displayName: string
  providerType: string
  executionMode: string
  isValidation: boolean
  enabled: boolean
  position: number | null
  costPerSuccessUsd: number | null
  returnsEducation: boolean
  returnsEmploymentDates: boolean
  notes: string | null
  mtdCostUsd: number
  mtdHits: number
}

function StatusBadge({ p }: { p: Provider }) {
  const label = !p.enabled ? 'Disabled' : 'Active'
  const cls = !p.enabled
    ? 'bg-gray-100 text-gray-500'
    : 'bg-green-100 text-green-700'
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium flex-shrink-0 ${cls}`}>
      {p.enabled && <span className="w-1.5 h-1.5 rounded-full bg-green-500" />}
      {label}
    </span>
  )
}

function Spend({ p }: { p: Provider }) {
  return (
    <span className="text-xs text-gray-500">
      MTD: ${p.mtdCostUsd.toFixed(2)} · {p.mtdHits} hit{p.mtdHits === 1 ? '' : 's'}
    </span>
  )
}

export function EnrichmentWaterfallPanel() {
  const [validation, setValidation] = useState<Provider[]>([])
  const [cascade, setCascade] = useState<Provider[]>([])
  const [loading, setLoading] = useState(true)
  const [degraded, setDegraded] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)

  async function load() {
    setLoading(true)
    setMessage(null)
    try {
      const res = await fetch('/api/enrichment/providers')
      const data = await res.json()
      if (data.degraded) setDegraded(true)
      const all: Provider[] = data.providers ?? []
      setValidation(all.filter(p => p.isValidation))
      setCascade(all.filter(p => !p.isValidation))
      setDirty(false)
    } catch {
      setDegraded(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  function onDrop(targetIndex: number) {
    if (dragIndex === null || dragIndex === targetIndex) return
    setCascade(prev => {
      const next = [...prev]
      const [moved] = next.splice(dragIndex, 1)
      next.splice(targetIndex, 0, moved)
      return next
    })
    setDragIndex(null)
    setDirty(true)
  }

  function toggleEnabled(key: string) {
    setCascade(prev => prev.map(p => (p.providerKey === key ? { ...p, enabled: !p.enabled } : p)))
    setDirty(true)
  }

  async function save() {
    setSaving(true)
    setMessage(null)
    try {
      const order = cascade.map((p, i) => ({ providerKey: p.providerKey, position: i + 1, enabled: p.enabled }))
      const res = await fetch('/api/enrichment/waterfall', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order }),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        setMessage(e.error ?? 'Save failed')
      } else {
        setMessage('Waterfall order saved.')
        setDirty(false)
      }
    } finally {
      setSaving(false)
    }
  }

  async function reset() {
    setSaving(true)
    setMessage(null)
    try {
      const res = await fetch('/api/enrichment/waterfall', { method: 'DELETE' })
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        setMessage(e.error ?? 'Reset failed')
      } else {
        setMessage('Reset to Lycert default.')
        await load()
      }
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <p className="text-sm text-gray-500">Loading providers…</p>

  if (degraded) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-5">
        <p className="text-sm text-amber-800 font-medium">Provider registry not available.</p>
        <p className="text-xs text-amber-700 mt-1">
          The V2 enrichment migrations (0024–0029) have not been applied to this environment yet.
          Provider configuration will appear once they are.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* Stage 0 — validation */}
      {validation.length > 0 && (
        <div>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
            Stage 0 — Email Validation Gate
          </h2>
          <div className="space-y-3">
            {validation.map(p => (
              <div key={p.providerKey} className="bg-white rounded-xl border border-gray-200 p-5 flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-gray-900">{p.displayName}</span>
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-700">Gate</span>
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5">{p.notes}</p>
                  <div className="mt-1"><Spend p={p} /></div>
                </div>
                <StatusBadge p={p} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Enrichment cascade */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
            Enrichment Waterfall (Platform-Managed) — drag to reorder
          </h2>
          <div className="flex items-center gap-2">
            <button
              onClick={reset}
              disabled={saving}
              className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            >
              Reset to Lycert default
            </button>
            <button
              onClick={save}
              disabled={saving || !dirty}
              className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save order'}
            </button>
          </div>
        </div>

        {message && <p className="text-xs text-gray-600 mb-3">{message}</p>}

        <div className="space-y-2">
          {cascade.map((p, i) => (
            <div
              key={p.providerKey}
              draggable
              onDragStart={() => setDragIndex(i)}
              onDragOver={e => e.preventDefault()}
              onDrop={() => onDrop(i)}
              className={`bg-white rounded-xl border p-4 flex items-center justify-between cursor-move ${
                dragIndex === i ? 'border-blue-400 opacity-70' : 'border-gray-200'
              } ${!p.enabled ? 'opacity-60' : ''}`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-gray-300 select-none" aria-hidden>⠿</span>
                <span className="w-6 h-6 rounded-md bg-gray-100 text-gray-600 text-xs font-semibold flex items-center justify-center flex-shrink-0">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-gray-900">{p.displayName}</span>
                    {p.executionMode === 'async' && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-50 text-purple-700">Async</span>
                    )}
                    {p.returnsEducation && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-50 text-emerald-700">Education</span>
                    )}
                    {p.costPerSuccessUsd != null && (
                      <span className="text-xs text-gray-400">~${Number(p.costPerSuccessUsd).toFixed(3)}/hit</span>
                    )}
                  </div>
                  <div className="mt-0.5"><Spend p={p} /></div>
                </div>
              </div>
              <label className="flex items-center gap-2 flex-shrink-0">
                <span className="text-xs text-gray-500">{p.enabled ? 'Enabled' : 'Disabled'}</span>
                <input
                  type="checkbox"
                  checked={p.enabled}
                  onChange={() => toggleEnabled(p.providerKey)}
                  className="h-4 w-4 rounded border-gray-300 text-blue-600"
                />
              </label>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
