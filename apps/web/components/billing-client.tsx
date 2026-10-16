'use client'

import { useState } from 'react'

interface Props {
  hasStripeCustomer: boolean
  isOwner: boolean
}

export function BillingClient({ hasStripeCustomer, isOwner }: Props) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [initialized, setInitialized] = useState(false)

  async function openPortal() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/billing/portal', { method: 'POST' })
      const json = await res.json() as { url?: string; error?: string }
      if (!res.ok || !json.url) {
        setError(json.error ?? 'Could not open billing portal.')
        return
      }
      window.location.href = json.url
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  async function initializeBilling() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/billing/initialize', { method: 'POST' })
      const json = await res.json() as { customer_id?: string; error?: string }
      if (!res.ok) {
        setError(json.error ?? 'Could not initialize billing.')
        return
      }
      setInitialized(true)
      window.location.reload()
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  if (!hasStripeCustomer && !initialized) {
    if (!isOwner) return null
    return (
      <div>
        <button
          onClick={initializeBilling}
          disabled={loading}
          className="px-4 py-2 bg-brand-600 text-white text-sm font-medium rounded-lg hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? 'Initializing…' : 'Initialize Billing'}
        </button>
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      </div>
    )
  }

  return (
    <div>
      <button
        onClick={openPortal}
        disabled={loading}
        className="px-4 py-2 bg-brand-600 text-white text-sm font-medium rounded-lg hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {loading ? 'Opening…' : 'Manage Subscription'}
      </button>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  )
}
