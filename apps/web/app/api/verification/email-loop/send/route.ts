import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { serviceClient } from '@/lib/enrichment/worker-io'
import { makeVerificationMailer } from '@/lib/verification/mailer'
import { issueEmailLoopChallenge, type IssueResult } from '@/lib/verification/email-loop-issue'
import { resolveInstitution, type AcademicDomainMatch } from '@/lib/verification/institution'

// POST /api/verification/email-loop/send — owner/admin EXPLICIT trigger to send email-loop links to one or
// more subscribers (Part 8.1). There is no cron/batch auto-send. Sends only when the mailer is fully
// enabled (LYCERT_RESEND_API_KEY + LYCERT_EMAIL_LOOP_ENABLED=true); otherwise every row returns
// 'mailer_disabled' and no email/challenge is created — safe by default for real students.
// Body: { subscriberIds: string[] }.

export const dynamic = 'force-dynamic'

type Row = Record<string, unknown>

async function getCtx() {
  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return null
  try {
    const payload = JSON.parse(Buffer.from(session.access_token.split('.')[1], 'base64').toString())
    return {
      tenantId: (payload.tenant_id as string | undefined) ?? null,
      role: (payload.user_role as string | undefined) ?? (payload.role as string | undefined),
    }
  } catch {
    return null
  }
}

export async function POST(req: NextRequest) {
  const ctx = await getCtx()
  if (!ctx?.tenantId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!['owner', 'admin'].includes(ctx.role ?? ''))
    return NextResponse.json({ error: 'Owner or admin role required' }, { status: 403 })

  const body = await req.json().catch(() => null)
  const ids = Array.isArray(body?.subscriberIds) ? (body.subscriberIds as string[]) : []
  if (!ids.length) return NextResponse.json({ error: 'subscriberIds required' }, { status: 400 })

  const db = serviceClient()
  const mailer = makeVerificationMailer()
  const baseUrl = process.env.LYCERT_VERIFY_BASE_URL || req.nextUrl.origin
  const { data: tenant } = await db.from('tenants').select('name').eq('id', ctx.tenantId).maybeSingle()
  const clientName = ((tenant as Row | null)?.name as string) ?? 'your software provider'

  async function lookupAcademicDomain(candidates: string[]): Promise<AcademicDomainMatch | null> {
    if (!candidates.length) return null
    const { data } = await db.from('academic_domains').select('domain, name, country').in('domain', candidates)
    const rows = (data ?? []) as unknown as Row[]
    if (!rows.length) return null
    rows.sort((a, b) => String(b.domain).length - String(a.domain).length)
    const r = rows[0]
    return { domain: String(r.domain), name: String(r.name ?? ''), country: (r.country as string) ?? null }
  }

  const deps = {
    now: () => new Date(),
    genToken: () => crypto.randomBytes(24).toString('hex'),
    mailer,
    baseUrl,
    clientName,
    async loadSubscriber(subscriberId: string, tenantId: string) {
      const { data } = await db
        .from('subscribers').select('email, name, institution_name')
        .eq('id', subscriberId).eq('tenant_id', tenantId).is('deleted_at', null).maybeSingle()
      if (!data) return null
      const r = data as unknown as Row
      return { email: (r.email as string | null) ?? null, name: (r.name as string | null) ?? null, institutionName: (r.institution_name as string | null) ?? null }
    },
    async resolveInstitutionDomains(institutionName: string | null, email: string | null) {
      const resolved = await resolveInstitution(
        { subscriberId: '', tenantId: ctx.tenantId!, email, name: null, institutionName, institutionCountry: null, statedGraduationDate: null },
        { lookupAcademicDomain },
      )
      return resolved.knownDomains
    },
    async persistChallenge(challenge: { subscriberId: string; email: string; token: string; issuedAt: string; expiresAt: string }, tenantId: string) {
      const { error } = await db.from('verification_challenges').insert({
        tenant_id: tenantId, subscriber_id: challenge.subscriberId, email: challenge.email,
        token: challenge.token, issued_at: challenge.issuedAt, expires_at: challenge.expiresAt,
      })
      if (error) throw new Error(`persistChallenge: ${error.message}`)
    },
  }

  const results: Record<string, IssueResult['reason']> = {}
  let sent = 0
  for (const id of ids) {
    const r = await issueEmailLoopChallenge(id, ctx.tenantId, deps)
    results[id] = r.reason
    if (r.sent) sent++
  }

  console.log('[verification/email-loop/send] tenant=%s requested=%d sent=%d mailer=%s', ctx.tenantId, ids.length, sent, mailer ? 'on' : 'OFF')
  return NextResponse.json({ ok: true, sent, mailerEnabled: !!mailer, results })
}
