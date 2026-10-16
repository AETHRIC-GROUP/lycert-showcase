/**
 * Public layout for the hosted re-verification flow (verify.lycert.com/...). No auth — subscribers
 * arrive via a signed link, not a logged-in session.
 */
export default function VerifyLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ maxWidth: '40rem', margin: '0 auto', padding: '3rem 1rem' }}>{children}</div>
    </div>
  )
}
