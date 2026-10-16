/**
 * Email-loop challenge ISSUE path (Part 8.1) — the piece that makes the email-loop live.
 *
 * Resolve the subscriber's institutional email → build a one-time challenge → persist it →
 * send the link. The link points at the existing click route, which resolves the token to CONTROL_PROVEN.
 *
 * Pure over injected IO so it is testable without a DB or a real send. SAFETY: if no mailer is configured
 * (the default — see mailer.ts double gate) NOTHING is persisted and NOTHING is sent; and a non-institutional
 * (personal) email is never emailed a loop link (it can't prove institutional control anyway).
 */
import { buildEmailLoopChallenge, emailDomainMatchesInstitution, type EmailLoopChallenge } from './providers/email-loop'
import type { VerificationMailer } from './mailer'

export type IssueResult = { sent: boolean; reason: 'sent' | 'mailer_disabled' | 'no_email' | 'not_institutional_email' | 'subscriber_not_found' }

export interface EmailLoopIssueDeps {
  now: () => Date
  genToken: () => string
  mailer: VerificationMailer | null
  /** Absolute origin for the click link, e.g. https://verify.lycert.com or the request origin. */
  baseUrl: string
  clientName: string
  loadSubscriber: (subscriberId: string, tenantId: string) => Promise<{ email: string | null; name: string | null; institutionName: string | null } | null>
  /** Known institutional email domains for this subscriber (Step-1 resolution). */
  resolveInstitutionDomains: (institutionName: string | null, email: string | null) => Promise<string[]>
  persistChallenge: (challenge: EmailLoopChallenge, tenantId: string) => Promise<void>
}

export function clickLink(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/$/, '')}/api/verification/email-loop/click?token=${encodeURIComponent(token)}`
}

export async function issueEmailLoopChallenge(
  subscriberId: string,
  tenantId: string,
  deps: EmailLoopIssueDeps,
): Promise<IssueResult> {
  const sub = await deps.loadSubscriber(subscriberId, tenantId)
  if (!sub) return { sent: false, reason: 'subscriber_not_found' }
  if (!sub.email) return { sent: false, reason: 'no_email' }

  // Eligibility (Part 8.1): the subscriber's email must map to a known institutional domain.
  const domains = await deps.resolveInstitutionDomains(sub.institutionName, sub.email)
  if (!emailDomainMatchesInstitution(sub.email, domains)) return { sent: false, reason: 'not_institutional_email' }

  // SAFETY gate: never persist/send when the mailer is off (no real student is contacted).
  if (!deps.mailer) return { sent: false, reason: 'mailer_disabled' }

  const challenge = buildEmailLoopChallenge(subscriberId, sub.email, { token: deps.genToken(), now: deps.now() })
  await deps.persistChallenge(challenge, tenantId)
  await deps.mailer.sendEmailLoopLink({
    to: challenge.email,
    link: clickLink(deps.baseUrl, challenge.token),
    institutionName: sub.institutionName,
    clientName: deps.clientName,
  })
  return { sent: true, reason: 'sent' }
}
