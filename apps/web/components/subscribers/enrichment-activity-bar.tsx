'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Live enrichment activity bar above the subscribers table.
 *
 * Solves three things without a full-page reload:
 *  1. Background indicator — when the V2 pipeline has async (FullEnrich) work outstanding
 *     (`pendingCount` = subscribers with a pending async provider, tenant-scoped server-side),
 *     a banner tells the user more enrichment is on the way.
 *  2. Auto-update — while work is outstanding it calls `router.refresh()` (re-runs the server
 *     component and reconciles in place — NOT a browser reload), so freshly-enriched rows and new
 *     scores appear on their own. Gated on tab visibility so a backgrounded tab doesn't poll.
 *  3. Manual refresh — a Refresh button that refreshes only this route's data (same `router.refresh`),
 *     so the user never has to reload the whole page.
 *
 * The "grace window" covers the gap right after clicking Enrich All: the synchronous providers run
 * first (nothing is `pending` yet), so we keep polling for a few minutes once the `lycert:enrich-started`
 * event fires (dispatched by EnrichAllButton). Once real async work exists, `pendingCount` keeps it alive.
 */

const POLL_MS = 10_000
const GRACE_MS = 3 * 60_000

function Spinner() {
  return (
    <svg className="h-3.5 w-3.5 animate-spin text-violet-600" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z" />
    </svg>
  )
}

export function EnrichmentActivityBar({ pendingCount }: { pendingCount: number }) {
  const router = useRouter()
  const [refreshing, setRefreshing] = useState(false)
  const [graceUntil, setGraceUntil] = useState(0)
  // Bumped by the poll tick purely to force a re-render so `active` re-evaluates against the clock
  // (lets the grace window expire even when props haven't changed).
  const [, tick] = useState(0)

  useEffect(() => {
    const onStarted = () => setGraceUntil(Date.now() + GRACE_MS)
    window.addEventListener('lycert:enrich-started', onStarted)
    return () => window.removeEventListener('lycert:enrich-started', onStarted)
  }, [])

  const active = pendingCount > 0 || Date.now() < graceUntil

  useEffect(() => {
    if (!active) return
    const onVisible = () => { if (document.visibilityState === 'visible') router.refresh() }
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh()
      tick(n => n + 1)
    }, POLL_MS)
    document.addEventListener('visibilitychange', onVisible)
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible) }
  }, [active, router])

  function manualRefresh() {
    setRefreshing(true)
    router.refresh()
    window.setTimeout(() => setRefreshing(false), 700)
  }

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-h-[1.75rem]">
        {pendingCount > 0 ? (
          <span className="inline-flex items-center gap-2 rounded-lg bg-violet-50 px-3 py-1.5 text-sm text-violet-700 ring-1 ring-violet-200">
            <Spinner />
            {pendingCount} subscriber{pendingCount > 1 ? 's' : ''} still enriching in the background — results appear automatically
          </span>
        ) : active ? (
          <span className="inline-flex items-center gap-2 rounded-lg bg-violet-50 px-3 py-1.5 text-sm text-violet-700 ring-1 ring-violet-200">
            <Spinner />
            Enrichment running — this table updates automatically…
          </span>
        ) : null}
      </div>
      <button
        onClick={manualRefresh}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
        title="Refresh this table without reloading the page"
      >
        <svg className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M21 12a9 9 0 11-2.64-6.36M21 3v6h-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Refresh
      </button>
    </div>
  )
}
