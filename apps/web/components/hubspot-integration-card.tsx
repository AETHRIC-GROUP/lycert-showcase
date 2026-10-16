'use client'

import { useState } from 'react'

export interface PropertyConflict { name: string; expectedType: string; actualType: string }
export interface SyncRunSummary { status: string; finishedAt: string | null; counts: Record<string, number> | null }

interface Props {
  connected: boolean
  status: 'connected' | 'error' | 'disconnected' | null
  lastError: string | null
  conflicts: PropertyConflict[]
  segmentConfigured: boolean
  segmentDefinition: { property: string; value: string } | null
  lastSyncRun: SyncRunSummary | null
}

export function HubspotIntegrationCard(props: Props) {
  const [connected, setConnected] = useState(props.connected)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [segmentConfigured, setSegmentConfigured] = useState(props.segmentConfigured)
  const [showSegmentForm, setShowSegmentForm] = useState(false)
  const [property, setProperty] = useState('')
  const [value, setValue] = useState('')

  async function handleDisconnect() {
    setError(null); setSuccess(null); setLoading(true)
    const res = await fetch('/api/crm/hubspot/disconnect', { method: 'POST' })
    setLoading(false)
    if (!res.ok) { setError('Failed to disconnect.'); return }
    setConnected(false)
    setSuccess('HubSpot disconnected.')
  }

  async function handleSaveSegment() {
    setError(null); setSuccess(null)
    if (!property.trim() || !value.trim()) { setError('Enter both a property name and the value that identifies EDU contacts.'); return }
    setLoading(true)
    const res = await fetch('/api/crm/segment', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ property: property.trim(), value: value.trim() }),
    })
    const body = await res.json().catch(() => ({}))
    setLoading(false)
    if (!res.ok) { setError(body.error ?? 'Failed to save segment.'); return }
    setSegmentConfigured(true)
    setShowSegmentForm(false)
    setSuccess('Segment saved — syncing contacts now.')
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-orange-50 flex items-center justify-center flex-shrink-0">
            <span className="text-orange-600 font-bold text-sm">HS</span>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-gray-900">HubSpot</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Mirror EDU contacts, estimate education status, write it back as contact properties
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
            <button onClick={handleDisconnect} disabled={loading}
              className="text-xs text-red-600 hover:text-red-700 font-medium disabled:opacity-50">
              Disconnect
            </button>
          ) : (
            <a href="/api/crm/hubspot/oauth/authorize"
              className="text-xs bg-brand-600 text-white px-3 py-1.5 rounded-lg hover:bg-brand-700 font-medium">
              Connect
            </a>
          )}
        </div>
      </div>

      {connected && props.status === 'error' && props.lastError && (
        <p className="mt-3 text-xs text-red-700 bg-red-50 rounded-lg px-3 py-2">
          Connection error: {props.lastError}
        </p>
      )}

      {connected && props.conflicts.length > 0 && (
        <div className="mt-3 text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2">
          {props.conflicts.length} Lycert propert{props.conflicts.length === 1 ? 'y' : 'ies'} could not be
          created because a property with the same name already exists with a different type:{' '}
          {props.conflicts.map(c => c.name).join(', ')}.
        </div>
      )}

      {connected && !segmentConfigured && (
        <div className="mt-4 border-t border-gray-100 pt-4">
          {!showSegmentForm ? (
            <button onClick={() => setShowSegmentForm(true)}
              className="text-xs bg-brand-600 text-white px-3 py-1.5 rounded-lg hover:bg-brand-700 font-medium">
              Define EDU segment
            </button>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-gray-500">
                Which HubSpot contact property (and value) identifies an EDU contact?
              </p>
              <div className="flex gap-2">
                <input value={property} onChange={e => setProperty(e.target.value)} placeholder="license_type"
                  className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono" />
                <input value={value} onChange={e => setValue(e.target.value)} placeholder="Education"
                  className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono" />
              </div>
              {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
              <div className="flex gap-2">
                <button onClick={() => setShowSegmentForm(false)}
                  className="flex-1 text-sm text-gray-600 border border-gray-300 rounded-lg px-4 py-2 hover:bg-gray-50">
                  Cancel
                </button>
                <button onClick={handleSaveSegment} disabled={loading}
                  className="flex-1 text-sm bg-brand-600 text-white rounded-lg px-4 py-2 hover:bg-brand-700 disabled:opacity-50">
                  {loading ? 'Saving…' : 'Save & sync'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {connected && segmentConfigured && props.segmentDefinition && (
        <p className="mt-3 text-xs text-gray-400">
          EDU segment: <span className="font-mono">{props.segmentDefinition.property} = {props.segmentDefinition.value}</span>
          {props.lastSyncRun && (
            <> · last sync {props.lastSyncRun.status}
              {props.lastSyncRun.finishedAt ? ` ${new Date(props.lastSyncRun.finishedAt).toLocaleString()}` : ' (in progress)'}
            </>
          )}
        </p>
      )}

      {success && <p className="mt-3 text-xs text-green-700 bg-green-50 rounded-lg px-3 py-2">{success}</p>}
    </div>
  )
}
