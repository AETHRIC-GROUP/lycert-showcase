import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '@/lib/enrichment/worker-io'
import { evaluateChallengeClick, type EmailLoopChallenge } from '@/lib/verification/providers/email-loop'
import { VerificationOutcome, statusFromOutcome } from '@/lib/verification/base'
import { patchFromOutcome } from '@/lib/verification/worker'
import type { VerificationSubscriberInput } from '@/lib/verification/base'

// GET /api/verification/email-loop/click?token=... — the email-loop proof event (Part 8.1). Clicking
// the one-time link from a verified institutional inbox proves CURRENT control of that inbox →
// CONTROL_PROVEN (semi_authoritative). This is the authoritative moment for the email-loop method; it
// writes the verification_result and the subscriber's status directly (the worker's email-loop provider
// is the secondary, waterfall-completeness path). Single-use: a consumed token cannot be replayed.

export const dynamic = 'force-dynamic'

type Row = Record<string, unknown>
const RESULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

function page(title: string, body: string, status = 200): NextResponse {
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
      `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
      `<h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  )
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token')
  if (!token) return page('Invalid link', 'This verification link is missing its token.', 400)

  const db = serviceClient()
  const { data } = await db
    .from('verification_challenges')
    .select('id, tenant_id, subscriber_id, email, token, issued_at, expires_at, consumed_at')
    .eq('token', token)
    .maybeSingle()
  if (!data) return page('Invalid link', 'This verification link is not recognized.', 404)
  const c = data as unknown as Row

  const now = new Date()
  const challenge: EmailLoopChallenge = {
    subscriberId: String(c.subscriber_id),
    email: String(c.email),
    token: String(c.token),
    issuedAt: String(c.issued_at),
    expiresAt: String(c.expires_at),
  }
  // Single-use replay guard + token/expiry resolution (pure, unit-tested in email-loop).
  const evaluated = evaluateChallengeClick(challenge, (c.consumed_at as string | null) ?? null, token, now)
  if (evaluated.kind === 'already_used') {
    return page('Already verified', 'This link has already been used. No further action is needed.')
  }
  const result = evaluated.result
  const tenantId = String(c.tenant_id)
  const subscriberId = String(c.subscriber_id)
  const proven = result.outcome === VerificationOutcome.CONTROL_PROVEN

  // Mark consumed (single-use) regardless of outcome, recording how it resolved.
  await db
    .from('verification_challenges')
    .update({ consumed_at: now.toISOString(), outcome: proven ? 'control_proven' : (new Date(challenge.expiresAt) <= now ? 'expired' : 'mismatch') })
    .eq('id', String(c.id))

  // Always record the attempt (audit; result-only, never PII).
  await db.from('verification_results').insert({
    tenant_id: tenantId,
    subscriber_id: subscriberId,
    provider_key: result.providerKey,
    method_class: result.methodClass,
    status: result.outcome,
    confidence: result.confidence,
    enrollment_status: result.enrollmentStatus,
    enrollment_end_date: result.enrollmentEndDate,
    as_of_date: result.asOfDate,
    consent_id: result.consentId,
    raw_reference: result.rawReference,
    checked_at: now.toISOString(),
    delete_at: new Date(now.getTime() + RESULT_RETENTION_MS).toISOString(),
  })

  if (!proven) {
    return page('Link expired', 'This verification link is no longer valid. Please request a new one.', 410)
  }

  // Apply the subscriber status patch, honouring the stale-alumni elevated-review guard (Part 8.1):
  // a control-proven loop on a long-graduated subscriber does NOT clear them.
  const { data: sub } = await db
    .from('subscribers')
    .select('stated_graduation_date')
    .eq('id', subscriberId)
    .maybeSingle()
  const input: VerificationSubscriberInput = {
    subscriberId,
    tenantId,
    email: challenge.email,
    name: null,
    institutionName: null,
    institutionCountry: null,
    statedGraduationDate: ((sub as unknown as Row | null)?.stated_graduation_date as string | null) ?? null,
  }
  const patch = patchFromOutcome(
    { winner: result, attempts: [{ providerKey: 'email_loop', ran: true, result }], subscriberStatus: statusFromOutcome(result.outcome), confidence: result.confidence },
    input,
    now,
  )
  // patch is null for a stale-alumni control_proven (Part 8.1): the result is recorded for audit, but the
  // subscriber stays in enrichment-driven elevated review rather than being cleared.
  if (patch) {
    await db
      .from('subscribers')
      .update({
        verification_status: patch.status,
        verification_method: patch.method,
        verification_confidence: patch.confidence,
        verified_at: patch.verifiedAt,
        verification_expires_at: patch.verificationExpiresAt,
      })
      .eq('id', subscriberId)
      .eq('tenant_id', tenantId)
  }

  return page('Verified', 'Thank you — your current enrollment has been confirmed. You can close this window.')
}
