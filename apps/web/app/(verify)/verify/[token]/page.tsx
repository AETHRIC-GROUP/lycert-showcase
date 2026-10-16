/**
 * Hosted re-verification / consent page (Part 6.1). The subscriber arrives via a signed link
 * (verify.lycert.com/verify/<token>). We validate the token, load their context server-side, and render
 * the consent screen. Submitting records consent only — it triggers no provider check.
 */
import { serviceClient } from '@/lib/enrichment/worker-io'
import { verifyLinkToken } from '@/lib/verification/link-token'
import { consentScreen } from '@/lib/verification/consent-text'
import { ConsentForm } from './consent-form'

export const dynamic = 'force-dynamic'

type Row = Record<string, unknown>

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: '2rem' }}>
      <h1 style={{ fontSize: '1.25rem', margin: '0 0 .5rem' }}>{title}</h1>
      <p style={{ color: '#475569', margin: 0 }}>{body}</p>
    </div>
  )
}

export default async function VerifyPage({ params }: { params: { token: string } }) {
  const v = verifyLinkToken(params.token)
  if (!v.valid) {
    const msg =
      v.reason === 'expired'
        ? 'This verification link has expired. Please request a new one from your software provider.'
        : 'This verification link is not valid.'
    return <Notice title="Link not valid" body={msg} />
  }

  const db = serviceClient()
  const { data: sub } = await db
    .from('subscribers')
    .select('id, name, email, institution_name')
    .eq('id', v.payload.sub).eq('tenant_id', v.payload.ten).is('deleted_at', null).maybeSingle()
  if (!sub) return <Notice title="Link not valid" body="We could not find your record. Please contact your software provider." />

  const { data: tenant } = await db.from('tenants').select('name').eq('id', v.payload.ten).maybeSingle()
  const s = sub as unknown as Row
  const clientName = ((tenant as Row | null)?.name as string) ?? 'your software provider'
  const screen = consentScreen({ clientName, expiresAt: new Date(v.payload.exp * 1000).toISOString() })

  return (
    <ConsentForm
      token={params.token}
      screen={screen}
      clientName={clientName}
      subscriberName={(s.name as string) ?? ''}
      institution={(s.institution_name as string) ?? ''}
    />
  )
}
