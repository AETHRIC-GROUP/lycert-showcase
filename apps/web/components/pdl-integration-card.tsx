'use client'

import { useState } from 'react'

interface Props {
  initialStatus: 'connected' | 'disconnected' | 'error' | null
  lastSyncAt: string | null
}

export function PdlIntegrationCard({ initialStatus, lastSyncAt }: Props) {
  const [status, setStatus] = useState(initialStatus)
  const [apiKey, setApiKey] = useState('')
  const [showInput, setShowInput] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  async function handleSave() {
    setError(null)
    setSuccess(null)
    if (!apiKey.trim()) { setError('Paste your PDL API key to continue.'); return }
    setLoading(true)
    const res = await fetch('/api/integrations/pdl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey }),
    })
    const body = await res.json()
    setLoading(false)
    if (!res.ok) { setError(body.error ?? 'Failed to save key.'); return }
    setStatus('connected')
    setShowInput(false)
    setApiKey('')
    setSuccess('PDL connected. Enrichment is ready.')
  }

  async function handleDisconnect() {
    setError(null)
    setSuccess(null)
    setLoading(true)
    await fetch('/api/integrations/pdl', { method: 'DELETE' })
    setLoading(false)
    setStatus('disconnected')
    setSuccess('PDL disconnected.')
  }

  const connected = status === 'connected'

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center flex-shrink-0">
            <span className="text-blue-700 font-bold text-xs">PDL</span>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-gray-900">People Data Labs</h3>
              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-700">
                Primary
              </span>
            </div>
            <p className="text-xs text-gray-500 mt-0.5">
              LinkedIn enrichment — employment history, education dates, location
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
            connected ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-green-500' : 'bg-gray-400'}`} />
            {connected ? 'Connected' : 'Not connected'}
          </span>
          {connected ? (
            <button
              onClick={handleDisconnect}
              disabled={loading}
              className="text-xs text-red-600 hover:text-red-700 font-medium disabled:opacity-50"
            >
              Disconnect
            </button>
          ) : (
            <button
              onClick={() => { setShowInput(true); setError(null); setSuccess(null) }}
              className="text-xs bg-brand-600 text-white px-3 py-1.5 rounded-lg hover:bg-brand-700 font-medium"
            >
              Connect
            </button>
          )}
        </div>
      </div>

      {connected && lastSyncAt && (
        <p className="mt-3 text-xs text-gray-400">
          Last enrichment: {new Date(lastSyncAt).toLocaleDateString()}
        </p>
      )}

      {showInput && !connected && (
        <div className="mt-4 space-y-3 border-t border-gray-100 pt-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              PDL API key
              <a
                href="https://dashboard.peopledatalabs.com/api-keys"
                target="_blank"
                rel="noopener noreferrer"
                className="ml-2 text-brand-600 hover:underline font-normal"
              >
                Get your key →
              </a>
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="Paste your PDL API key"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
            />
          </div>
          <p className="text-xs text-gray-400">
            $0.28 per successful match. 404s (no match found) are free.
          </p>
          {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
          <div className="flex gap-2">
            <button
              onClick={() => { setShowInput(false); setApiKey(''); setError(null) }}
              className="flex-1 text-sm text-gray-600 border border-gray-300 rounded-lg px-4 py-2 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={loading}
              className="flex-1 text-sm bg-brand-600 text-white rounded-lg px-4 py-2 hover:bg-brand-700 disabled:opacity-50"
            >
              {loading ? 'Saving…' : 'Save key'}
            </button>
          </div>
        </div>
      )}

      {success && (
        <p className="mt-3 text-xs text-green-700 bg-green-50 rounded-lg px-3 py-2">{success}</p>
      )}
    </div>
  )
}
