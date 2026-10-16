'use client'

import { useState } from 'react'

type Screen = {
  heading: string
  intro: string
  bullets: { label: string; text: string }[]
  affirmation: string
  draftNotice: string
}

const card: React.CSSProperties = { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: '2rem' }

export function ConsentForm(props: {
  token: string
  screen: Screen
  clientName: string
  subscriberName: string
  institution: string
}) {
  const { token, screen } = props
  const [fullName, setFullName] = useState(props.subscriberName)
  const [agreed, setAgreed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function submit() {
    setError(null)
    setLoading(true)
    const res = await fetch('/api/verification/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, fullName: fullName.trim(), agreed }),
    })
    const body = await res.json().catch(() => ({}))
    setLoading(false)
    if (!res.ok) { setError(body.error ?? 'Something went wrong. Please try again.'); return }
    setDone(true)
  }

  if (done) {
    return (
      <div style={card}>
        <h1 style={{ fontSize: '1.25rem', margin: '0 0 .5rem' }}>Thank you</h1>
        <p style={{ color: '#475569', margin: 0 }}>
          Your authorization has been recorded. {props.clientName} will confirm your enrollment status. You can close this window.
        </p>
      </div>
    )
  }

  return (
    <div style={card}>
      <h1 style={{ fontSize: '1.4rem', margin: '0 0 .75rem' }}>{screen.heading}</h1>
      <p style={{ color: '#334155' }}>{screen.intro}</p>
      {props.institution ? <p style={{ color: '#64748b', fontSize: '.9rem' }}>School on file: <strong>{props.institution}</strong></p> : null}

      <ul style={{ listStyle: 'none', padding: 0, margin: '1.25rem 0' }}>
        {screen.bullets.map(b => (
          <li key={b.label} style={{ marginBottom: '.75rem', fontSize: '.92rem', lineHeight: 1.45 }}>
            <span style={{ fontWeight: 600 }}>{b.label}:</span> <span style={{ color: '#475569' }}>{b.text}</span>
          </li>
        ))}
      </ul>

      <label style={{ display: 'flex', gap: '.6rem', alignItems: 'flex-start', margin: '1rem 0', fontSize: '.95rem' }}>
        <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} style={{ marginTop: '.2rem' }} />
        <span>{screen.affirmation}</span>
      </label>

      <label style={{ display: 'block', margin: '0 0 1rem' }}>
        <span style={{ display: 'block', fontSize: '.85rem', color: '#64748b', marginBottom: '.3rem' }}>Full name (typed name = electronic signature)</span>
        <input
          value={fullName}
          onChange={e => setFullName(e.target.value)}
          placeholder="Your full name"
          style={{ width: '100%', padding: '.6rem .75rem', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: '1rem' }}
        />
      </label>

      {error ? <p style={{ color: '#dc2626', fontSize: '.9rem' }}>{error}</p> : null}

      <button
        onClick={submit}
        disabled={loading || !agreed || fullName.trim().length < 2}
        style={{
          width: '100%', padding: '.7rem', borderRadius: 8, border: 'none', fontSize: '1rem', fontWeight: 600,
          color: '#fff', background: loading || !agreed || fullName.trim().length < 2 ? '#94a3b8' : '#2563eb',
          cursor: loading || !agreed || fullName.trim().length < 2 ? 'not-allowed' : 'pointer',
        }}
      >
        {loading ? 'Submitting…' : 'Confirm and continue'}
      </button>

      <p style={{ color: '#94a3b8', fontSize: '.78rem', marginTop: '1rem', fontStyle: 'italic' }}>{screen.draftNotice}</p>
    </div>
  )
}
