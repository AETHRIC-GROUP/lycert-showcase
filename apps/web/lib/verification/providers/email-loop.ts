/**
 * Email-loop verification provider (Step 4) — LYCERT_VERIFICATION_ARCHITECTURE.md Part 2 Step 4 + Part 8.1.
 *
 * Globally applicable, no external agreement, highest-ROI first build. A one-time, expiring, single-use
 * link is sent to a verified INSTITUTIONAL address; clicking it proves CURRENT control of an institutional
 * inbox → CONTROL_PROVEN at SEMI_AUTHORITATIVE confidence (NOT fully authoritative, because some
 * institutions keep alumni email alive — the known false positive).
 *
 * This module is the PURE core (eligibility, challenge construction, click resolution, alumni-risk flag).
 * The actual link send (Resend) and the token store live in the IO layer, which is built when Phase 2's
 * email infrastructure lands; this core is what they call, and it is fully unit-tested now.
 */

import {
  type ConsentRecord,
  type VerificationProvider,
  type VerificationResult,
  type VerificationSubscriberInput,
  VerificationOutcome,
  makeVerificationResult,
} from '../base'

const PROVIDER_KEY = 'email_loop'
const METHOD_CLASS = 'semi_authoritative' as const

/** A stored email-loop challenge (one per send). The token is single-use; the IO layer persists it. */
export interface EmailLoopChallenge {
  subscriberId: string
  email: string // the institutional address the link was sent to
  token: string
  issuedAt: string // ISO
  expiresAt: string // ISO
}

function domainOf(email: string): string | null {
  const at = email.lastIndexOf('@')
  if (at < 0 || at === email.length - 1) return null
  return email.slice(at + 1).trim().toLowerCase()
}

/**
 * Eligibility (Part 2 Step 4): the subscriber's email domain must map to the resolved institution's
 * known domains. Matches the domain itself OR any subdomain of it (same rule as the enrichment
 * institution-domain cross-link, e.g. `campus.ul.pt` under `ul.pt`). Personal/Gmail addresses → not
 * eligible (the waterfall continues to documents).
 */
export function emailDomainMatchesInstitution(
  email: string | null,
  institutionDomains: readonly string[],
): boolean {
  if (!email) return false
  const d = domainOf(email)
  if (!d) return false
  for (const raw of institutionDomains) {
    const inst = raw.trim().toLowerCase()
    if (!inst) continue
    if (d === inst || d.endsWith('.' + inst)) return true
  }
  return false
}

/** Build a single-use, expiring challenge (pure — the token + clock are injected for determinism). */
export function buildEmailLoopChallenge(
  subscriberId: string,
  email: string,
  opts: { token: string; now: Date; ttlMinutes?: number },
): EmailLoopChallenge {
  const ttl = opts.ttlMinutes ?? 60 * 24 // 24h default
  const expires = new Date(opts.now.getTime() + ttl * 60_000)
  return {
    subscriberId,
    email: email.trim().toLowerCase(),
    token: opts.token,
    issuedAt: opts.now.toISOString(),
    expiresAt: expires.toISOString(),
  }
}

/**
 * Resolve a click against a stored challenge. Token must match (single-use, constant-importance compare)
 * and not be expired. Success → CONTROL_PROVEN (semi_authoritative). Mismatch/expired → UNABLE_TO_CONFIRM
 * (NEVER adverse — Part 2.1).
 */
export function resolveEmailLoopClick(
  challenge: EmailLoopChallenge,
  clickedToken: string,
  now: Date,
): VerificationResult {
  const expired = new Date(challenge.expiresAt).getTime() <= now.getTime()
  const tokenOk = clickedToken === challenge.token
  if (tokenOk && !expired) {
    return makeVerificationResult(PROVIDER_KEY, METHOD_CLASS, VerificationOutcome.CONTROL_PROVEN, {
      asOfDate: now.toISOString().slice(0, 10),
      rawReference: challenge.token,
    })
  }
  return makeVerificationResult(PROVIDER_KEY, METHOD_CLASS, VerificationOutcome.UNABLE_TO_CONFIRM, {
    rawReference: challenge.token,
    errorMessage: expired ? 'email_loop link expired' : 'email_loop token mismatch',
  })
}

/** Single-use evaluation of a clicked link against a stored challenge row (Part 8.1). The replay guard
 * is encoded HERE so it is unit-tested independently of the route: a challenge with `consumedAt` set has
 * already been used and is NEVER re-resolved, even with the correct, unexpired token. */
export type ChallengeClickEval =
  | { kind: 'already_used' }
  | { kind: 'resolved'; result: VerificationResult }

export function evaluateChallengeClick(
  challenge: EmailLoopChallenge,
  consumedAt: string | null,
  clickedToken: string,
  now: Date,
): ChallengeClickEval {
  if (consumedAt) return { kind: 'already_used' } // single-use: no replay
  return { kind: 'resolved', result: resolveEmailLoopClick(challenge, clickedToken, now) }
}

/**
 * False-positive control (Part 8.1): if graduation is well in the past AND only the email-loop passed,
 * keep the subscriber in elevated review (an alumni-retained address can pass the loop). This is a
 * review/scoring hint, not a verdict — it does NOT flip CONTROL_PROVEN to adverse.
 */
export function isStaleAlumniRisk(
  statedGraduationDate: string | null,
  now: Date,
  yearsThreshold = 2,
): boolean {
  if (!statedGraduationDate) return false
  const grad = new Date(statedGraduationDate)
  if (Number.isNaN(grad.getTime())) return false
  const years = (now.getTime() - grad.getTime()) / (365.25 * 24 * 60 * 60 * 1000)
  return years >= yearsThreshold
}

/**
 * The VerificationProvider wrapper. In the synchronous waterfall, the email-loop can only return a
 * terminal CONTROL_PROVEN when a completed (clicked, unexpired) challenge already exists for the
 * subscriber — that lookup is injected. With no completed challenge yet, it returns UNABLE_TO_CONFIRM so
 * the orchestrator falls through (the link send / re-prompt is driven separately by the hosted flow).
 */
export function makeEmailLoopProvider(deps: {
  now: () => Date
  getCompletedChallenge: (subscriberId: string) => Promise<EmailLoopChallenge | null>
}): VerificationProvider {
  return {
    providerKey: PROVIDER_KEY,
    methodClass: METHOD_CLASS,
    requiresConsent: false, // sending a link to one's own institutional inbox needs no FERPA consent row
    canAssertNotEnrolled: false, // semi-authoritative: can prove control, can NEVER refute enrollment
    async verify(input: VerificationSubscriberInput, _consent: ConsentRecord | null): Promise<VerificationResult> {
      const challenge = await deps.getCompletedChallenge(input.subscriberId)
      if (!challenge) {
        return makeVerificationResult(PROVIDER_KEY, METHOD_CLASS, VerificationOutcome.UNABLE_TO_CONFIRM, {
          errorMessage: 'email_loop: no completed challenge for subscriber',
        })
      }
      return resolveEmailLoopClick(challenge, challenge.token, deps.now())
    },
  }
}
