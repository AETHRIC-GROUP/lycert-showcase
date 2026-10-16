'use client'

import { useState } from 'react'

// Mints a signed hosted re-verification link for this subscriber (POST /api/verification/invite)
// and copies it to the clipboard. Owner/admin only (the route enforces it too). Nothing is emailed —
// this is the manual "send it yourself" affordance from the Part 6.1 hosted flow.

export function CopyVerificationLinkButton({ subscriberId }: { subscriberId: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'copied' | 'error'>('idle')
  const [detail, setDetail] = useState('')

  async function copyLink() {
    setState('busy')
    try {
      const res = await fetch('/api/verification/invite', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriberId }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      await navigator.clipboard.writeText(json.url as string)
      setDetail(`expires in ${json.expiresInDays} days`)
      setState('copied')
      setTimeout(() => setState('idle'), 4000)
    } catch (e) {
      setDetail(e instanceof Error ? e.message : String(e))
      setState('error')
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button onClick={copyLink} disabled={state === 'busy'}
        className="px-3 py-1.5 border border-gray-300 rounded-lg text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">
        {state === 'busy' ? 'Generating…' : state === 'copied' ? 'Link copied ✓' : 'Copy re-verification link'}
      </button>
      {state === 'copied' && <span className="text-xs text-gray-500">{detail}</span>}
      {state === 'error' && <span className="text-xs text-red-600">{detail}</span>}
    </span>
  )
}
