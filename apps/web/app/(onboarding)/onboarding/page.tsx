'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

type Step = 1 | 2 | 3

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 48)
}

export default function OnboardingPage() {
  const router = useRouter()

  const [step, setStep] = useState<Step>(1)
  const [companyName, setCompanyName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [dpaName, setDpaName] = useState('')
  const [dpaAccepted, setDpaAccepted] = useState(false)
  const [fcraAccepted, setFcraAccepted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  function handleCompanyNameChange(val: string) {
    setCompanyName(val)
    if (!slugEdited) setSlug(slugify(val))
  }

  async function handleComplete() {
    setError(null)
    setLoading(true)

    const res = await fetch('/api/onboarding/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        company_name: companyName.trim(),
        slug: slug.trim(),
        dpa_signed_by: dpaName.trim(),
      }),
    })

    const body = await res.json()

    if (!res.ok) {
      setError(body.error ?? 'Something went wrong. Please try again.')
      setLoading(false)
      return
    }

    // Refresh JWT so tenant_id gets injected by the custom_access_token_hook
    const supabase = createClient()
    await supabase.auth.refreshSession()

    router.push('/dashboard')
    router.refresh()
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4">
      <div className="w-full max-w-lg">

        {/* Progress */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-bold text-brand-700 tracking-tight">Lycert</span>
            <span className="text-xs text-gray-400">Step {step} of 3</span>
          </div>
          <div className="h-1.5 bg-gray-200 rounded-full">
            <div
              className="h-1.5 bg-brand-600 rounded-full transition-all"
              style={{ width: `${(step / 3) * 100}%` }}
            />
          </div>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">

          {/* ── Step 1: Company details ── */}
          {step === 1 && (
            <>
              <h1 className="text-xl font-bold text-gray-900 mb-1">Your company</h1>
              <p className="text-sm text-gray-500 mb-6">
                This is how your account will appear in Lycert.
              </p>

              <div className="space-y-5">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Company name
                  </label>
                  <input
                    type="text"
                    required
                    value={companyName}
                    onChange={e => handleCompanyNameChange(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
                    placeholder="Acme Software Inc."
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Account slug
                    <span className="ml-1 font-normal text-gray-400 text-xs">(URL identifier)</span>
                  </label>
                  <div className="flex rounded-lg border border-gray-300 overflow-hidden focus-within:ring-2 focus-within:ring-brand-500 focus-within:border-transparent">
                    <span className="px-3 py-2 bg-gray-50 text-gray-400 text-sm border-r border-gray-300 select-none">
                      lycert.com/
                    </span>
                    <input
                      type="text"
                      value={slug}
                      onChange={e => {
                        setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
                        setSlugEdited(true)
                      }}
                      className="flex-1 px-3 py-2 text-sm focus:outline-none"
                      placeholder="acme-software"
                    />
                  </div>
                </div>

                <button
                  type="button"
                  disabled={!companyName.trim() || !slug.trim()}
                  onClick={() => setStep(2)}
                  className="w-full bg-brand-600 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  Continue
                </button>
              </div>
            </>
          )}

          {/* ── Step 2: DPA acceptance ── */}
          {step === 2 && (
            <>
              <h1 className="text-xl font-bold text-gray-900 mb-1">Data Processing Agreement</h1>
              <p className="text-sm text-gray-500 mb-6">
                GDPR requires a signed DPA before Lycert can process your subscribers&apos; personal
                data. Please review and accept below.
              </p>

              <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mb-5 text-sm text-gray-700 space-y-2 max-h-48 overflow-y-auto">
                <p className="font-semibold">Data Processing Agreement Summary</p>
                <p>
                  By accepting, you confirm that you are authorised to enter into this agreement on
                  behalf of your organisation. Lycert will process personal data (name, email,
                  employment status, graduation date) only for the purpose of verifying subscriber
                  eligibility for educational software licences.
                </p>
                <p>
                  Lawful basis: Legitimate interests (GDPR Art. 6(1)(f)). Data subjects retain all
                  rights under GDPR including access, rectification, erasure, and objection.
                  Enrichment data is deleted within 30 days of scoring.
                </p>
                <p>
                  Full DPA available at{' '}
                  <a
                    href="https://lycert.com/dpa"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-brand-600 underline"
                  >
                    lycert.com/dpa
                  </a>
                  .
                </p>
              </div>

              <div className="space-y-5">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Your full name <span className="text-gray-400 text-xs">(signatory)</span>
                  </label>
                  <input
                    type="text"
                    value={dpaName}
                    onChange={e => setDpaName(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
                    placeholder="Jane Smith"
                  />
                </div>

                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={dpaAccepted}
                    onChange={e => setDpaAccepted(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                  />
                  <span className="text-sm text-gray-700">
                    I have read and agree to the{' '}
                    <a
                      href="https://lycert.com/dpa"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-brand-600 underline"
                    >
                      Data Processing Agreement
                    </a>{' '}
                    on behalf of my organisation, and I am authorised to do so.
                  </span>
                </label>

                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => setStep(1)}
                    className="flex-1 bg-white text-gray-700 border border-gray-300 rounded-lg px-4 py-2 text-sm font-medium hover:bg-gray-50 transition-colors"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    disabled={!dpaName.trim() || !dpaAccepted}
                    onClick={() => setStep(3)}
                    className="flex-1 bg-brand-600 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    Accept & continue
                  </button>
                </div>
              </div>
            </>
          )}

          {/* ── Step 3: FCRA notice ── */}
          {step === 3 && (
            <>
              <h1 className="text-xl font-bold text-gray-900 mb-1">Compliance notice</h1>
              <p className="text-sm text-gray-500 mb-6">
                Please read and acknowledge the following before using Lycert.
              </p>

              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-5 text-sm text-amber-900 space-y-3">
                <p className="font-semibold">Fair Credit Reporting Act (FCRA) Notice</p>
                <p>
                  Lycert is not a Consumer Reporting Agency (CRA) under the FCRA. Lycert&apos;s
                  reports are for internal licence compliance purposes only and must not be used as
                  a factor in any decision governed by the FCRA, including but not limited to credit,
                  employment, insurance, or housing decisions.
                </p>
                <p>
                  US-based customers are responsible for obtaining independent legal advice on FCRA
                  applicability before onboarding US subscribers. Lycert does not provide legal
                  advice.
                </p>
              </div>

              <div className="space-y-5">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={fcraAccepted}
                    onChange={e => setFcraAccepted(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                  />
                  <span className="text-sm text-gray-700">
                    I understand that Lycert is not a Consumer Reporting Agency and I will not use
                    Lycert outputs in FCRA-governed decisions.
                  </span>
                </label>

                {error && (
                  <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>
                )}

                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => setStep(2)}
                    className="flex-1 bg-white text-gray-700 border border-gray-300 rounded-lg px-4 py-2 text-sm font-medium hover:bg-gray-50 transition-colors"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    disabled={!fcraAccepted || loading}
                    onClick={handleComplete}
                    className="flex-1 bg-brand-600 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {loading ? 'Setting up…' : 'Complete setup'}
                  </button>
                </div>
              </div>
            </>
          )}

        </div>
      </div>
    </div>
  )
}
