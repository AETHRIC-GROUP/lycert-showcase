'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { LIFECYCLE_LABELS, LIFECYCLE_COLORS, type LifecycleStage } from '@/lib/utils/lifecycle'

export interface SubscriberRowView {
  id: string
  email: string
  name: string | null
  institution_name: string | null
  institution_country_normalized: string | null
  stated_graduation_date: string | null
  lifecycle_stage: string
  email_domain_type: string | null
  estimatedScore: number
  estimatedTier: number
  hasLatestScore: boolean
  signalsFired: number
  dataGaps: number
  enrichmentProvider: string | null
  enrichMiss: boolean
}

const DOMAIN_BADGE: Record<string, { label: string; cls: string }> = {
  academic:   { label: 'Academic',   cls: 'bg-blue-50 text-blue-700 ring-1 ring-blue-200' },
  personal:   { label: 'Personal',   cls: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200' },
  corporate:  { label: 'Corporate',  cls: 'bg-red-50 text-red-700 ring-1 ring-red-200' },
  disposable: { label: 'Disposable', cls: 'bg-purple-50 text-purple-700 ring-1 ring-purple-200' },
}

const PROVIDER_BADGE: Record<string, { label: string; cls: string }> = {
  pdl:            { label: 'PDL',        cls: 'bg-violet-50 text-violet-700 ring-1 ring-violet-200' },
  pdl_identify:   { label: 'PDL ID',     cls: 'bg-violet-50 text-violet-700 ring-1 ring-violet-200' },
  apollo:         { label: 'Apollo',     cls: 'bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200' },
  hunter:         { label: 'Hunter',     cls: 'bg-orange-50 text-orange-700 ring-1 ring-orange-200' },
  reversecontact: { label: 'ReverseC.',  cls: 'bg-teal-50 text-teal-700 ring-1 ring-teal-200' },
  datagma:        { label: 'Datagma',    cls: 'bg-cyan-50 text-cyan-700 ring-1 ring-cyan-200' },
  fullenrich:     { label: 'FullEnrich', cls: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200' },
}

/** Badge for any enrichment_provider value — falls back to the raw key (capitalised) so a new/unknown
 * provider is still shown rather than rendering blank (the bug where only PDL appeared). */
function providerBadgeFor(key: string): { label: string; cls: string } {
  return PROVIDER_BADGE[key] ?? { label: key.charAt(0).toUpperCase() + key.slice(1), cls: 'bg-gray-50 text-gray-600 ring-1 ring-gray-200' }
}

function TierBadge({ tier, score }: { tier: number; score: number }) {
  const cls =
    tier === 1 ? 'bg-red-50 text-red-700 ring-1 ring-red-200' :
    tier === 2 ? 'bg-orange-50 text-orange-700 ring-1 ring-orange-200' :
    tier === 3 ? 'bg-yellow-50 text-yellow-700 ring-1 ring-yellow-200' :
                 'bg-green-50 text-green-700 ring-1 ring-green-200'
  const label = tier === 0 ? 'Clean' : `T${tier}`
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-semibold ${cls}`}>
      <span className="font-mono">{score}</span>
      <span className="opacity-60">·</span>
      <span>{label}</span>
    </span>
  )
}

type PendingAction = 'archive' | 'purge' | 'restore' | 'reprocess'

export function SubscribersTable({
  rows,
  canDelete,
  view,
}: {
  rows: SubscriberRowView[]
  canDelete: boolean
  view: 'live' | 'archived'
}) {
  const router = useRouter()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [confirmText, setConfirmText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const allSelected = rows.length > 0 && selected.size === rows.length
  const selectable = canDelete

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(rows.map(r => r.id)))
  }

  function openAction(action: PendingAction) {
    setError(null)
    setConfirmText('')
    setPending(action)
  }

  async function runAction() {
    if (!pending) return
    setBusy(true)
    setError(null)
    const ids = Array.from(selected)
    try {
      if (pending === 'reprocess') {
        // Reset the derived pre-enrichment columns for the selection, then re-run the batch (it only
        // processes rows whose email_domain_type is NULL, which the reset just made true for these).
        const reset = await fetch('/api/pre-enrich/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscriberIds: ids }),
        })
        const resetJson = (await reset.json()) as { affected?: number; error?: string }
        if (!reset.ok) throw new Error(resetJson.error ?? `Reset failed (${reset.status})`)
        const rerun = await fetch('/api/pre-enrich/batch', { method: 'POST' })
        if (!rerun.ok) {
          const j = (await rerun.json().catch(() => null)) as { error?: string } | null
          throw new Error(j?.error ?? `Pre-enrichment re-run failed (${rerun.status})`)
        }
        setPending(null)
        setSelected(new Set())
        router.refresh()
        return
      }
      const url = pending === 'restore' ? '/api/subscribers/restore' : '/api/subscribers/delete'
      const body = pending === 'restore' ? { ids } : { ids, mode: pending }
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = (await res.json()) as { affected?: number; error?: string }
      if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`)
      setPending(null)
      setSelected(new Set())
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  const count = selected.size
  const purgeConfirmed = pending !== 'purge' || confirmText.trim().toUpperCase() === 'DELETE'

  return (
    <div className="space-y-3">
      {/* Bulk action bar */}
      {selectable && count > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm">
          <span className="font-medium text-gray-700">{count} selected</span>
          <button onClick={() => setSelected(new Set())} className="text-gray-400 hover:text-gray-600">
            Clear
          </button>
          <div className="ml-auto flex gap-2">
            {view === 'archived' ? (
              <button
                onClick={() => openAction('restore')}
                className="px-3 py-1.5 rounded-lg border border-gray-300 bg-white font-medium text-gray-700 hover:bg-gray-50"
              >
                Restore
              </button>
            ) : (
              <>
                <button
                  onClick={() => openAction('reprocess')}
                  className="px-3 py-1.5 rounded-lg border border-gray-300 bg-white font-medium text-gray-700 hover:bg-gray-50"
                >
                  Re-run pre-enrichment
                </button>
                <button
                  onClick={() => openAction('archive')}
                  className="px-3 py-1.5 rounded-lg border border-gray-300 bg-white font-medium text-gray-700 hover:bg-gray-50"
                >
                  Archive
                </button>
              </>
            )}
            <button
              onClick={() => openAction('purge')}
              className="px-3 py-1.5 rounded-lg bg-red-600 font-medium text-white hover:bg-red-700"
            >
              Delete permanently
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100">
                {selectable && (
                  <th className="px-4 py-2.5 w-10">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      aria-label="Select all"
                      className="rounded border-gray-300"
                    />
                  </th>
                )}
                {['Name / Email', 'Institution', 'Graduation', 'Stage', 'Email Domain', 'Risk Score', 'Signals', 'Enrichment'].map(h => (
                  <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-gray-400 uppercase tracking-wide whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {rows.map(s => {
                const domainBadge = s.email_domain_type ? DOMAIN_BADGE[s.email_domain_type] : null
                const providerBadge = s.enrichmentProvider ? providerBadgeFor(s.enrichmentProvider) : null
                const isSelected = selected.has(s.id)
                return (
                  <tr key={s.id} className={`transition-colors ${isSelected ? 'bg-blue-50/50' : 'hover:bg-gray-50/70'}`}>
                    {selectable && (
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggle(s.id)}
                          aria-label={`Select ${s.name ?? s.email}`}
                          className="rounded border-gray-300"
                        />
                      </td>
                    )}
                    <td className="px-4 py-3">
                      <Link href={`/dashboard/subscribers/${s.id}`} className="group block">
                        <div className="font-medium text-gray-900 group-hover:text-gray-600 transition-colors">{s.name ?? '—'}</div>
                        <div className="text-gray-400 text-xs mt-0.5">{s.email}</div>
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-gray-700 text-sm">{s.institution_name ?? '—'}</div>
                      {s.institution_country_normalized && (
                        <div className="text-gray-400 text-xs mt-0.5">{s.institution_country_normalized}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-600 whitespace-nowrap text-sm">
                      {s.stated_graduation_date
                        ? new Date(s.stated_graduation_date).toLocaleDateString('en-GB', { year: 'numeric', month: 'short' })
                        : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap ${LIFECYCLE_COLORS[s.lifecycle_stage as LifecycleStage] ?? 'bg-gray-100 text-gray-500'}`}>
                        {LIFECYCLE_LABELS[s.lifecycle_stage as LifecycleStage] ?? s.lifecycle_stage}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {domainBadge
                        ? <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${domainBadge.cls}`}>{domainBadge.label}</span>
                        : <span className="text-gray-300 text-xs">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <TierBadge tier={s.estimatedTier} score={s.estimatedScore} />
                      {!s.hasLatestScore && s.estimatedScore > 0 && (
                        <div className="text-gray-400 text-xs mt-0.5">est.</div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <div className="text-sm font-medium text-gray-700">{s.signalsFired}</div>
                        <div className="text-xs text-gray-400">/ 11</div>
                        {s.dataGaps > 0 && (
                          <div className="text-xs text-gray-300" title={`${s.dataGaps} data gaps`}>({s.dataGaps} gaps)</div>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {providerBadge
                        ? <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${providerBadge.cls}`}>{providerBadge.label}</span>
                        : s.enrichMiss
                        ? <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-500 ring-1 ring-gray-200" title="No match found across the enrichment providers">No match</span>
                        : <span className="text-gray-300 text-xs">—</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Confirm modal */}
      {pending && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-gray-900">
              {pending === 'archive' && `Archive ${count} subscriber${count > 1 ? 's' : ''}?`}
              {pending === 'restore' && `Restore ${count} subscriber${count > 1 ? 's' : ''}?`}
              {pending === 'purge' && `Permanently delete ${count} subscriber${count > 1 ? 's' : ''}?`}
              {pending === 'reprocess' && `Re-run pre-enrichment for ${count} subscriber${count > 1 ? 's' : ''}?`}
            </h2>
            <p className="mt-2 text-sm text-gray-500">
              {pending === 'archive' && 'Archived subscribers are hidden from this list but kept (with their audit trail) and can be restored later from the Archived view.'}
              {pending === 'restore' && 'These subscribers will return to the active list.'}
              {pending === 'purge' && 'This erases the subscribers and all their scores, cases and enrichment data. This cannot be undone — use it for data-erasure (GDPR) requests.'}
              {pending === 'reprocess' && 'Resets the derived classification (email domain type, normalized institution/countries, priority) and re-derives it — use after a data fix or reference-set update so corrections propagate. Free unless the PDL cleaners run. Imported source fields are untouched.'}
            </p>

            {pending === 'purge' && (
              <div className="mt-4">
                <label className="block text-xs font-medium text-gray-600">Type DELETE to confirm</label>
                <input
                  autoFocus
                  value={confirmText}
                  onChange={e => setConfirmText(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
                  placeholder="DELETE"
                />
              </div>
            )}

            {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => { setPending(null); setError(null) }}
                disabled={busy}
                className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={runAction}
                disabled={busy || !purgeConfirmed}
                className={`px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50 ${
                  pending === 'purge' ? 'bg-red-600 hover:bg-red-700' : 'bg-gray-900 hover:bg-gray-700'
                }`}
              >
                {busy ? 'Working…' : pending === 'archive' ? 'Archive' : pending === 'restore' ? 'Restore' : pending === 'reprocess' ? 'Re-run' : 'Delete permanently'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
