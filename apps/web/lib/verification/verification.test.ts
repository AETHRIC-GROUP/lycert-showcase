/** Verification layer tests — LYCERT_VERIFICATION_ARCHITECTURE.md Parts 2, 5, 6, 8.
 * Covers the legal asymmetry (only authoritative NOT_ENROLLED is adverse; absence of confirmation is
 * never adverse), the consent gate (skip-not-fail), the waterfall stop/order rules, and the email-loop. */
import { describe, it, expect } from 'vitest'
import {
  VerificationOutcome,
  isTerminal,
  isAdverse,
  statusFromOutcome,
  defaultConfidenceFor,
  makeVerificationResult,
  type ConsentRecord,
  type VerificationProvider,
  type VerificationSubscriberInput,
} from './base'
import { isConsentActive, checkConsentGate } from './consent'
import { runVerificationWaterfall, type OrchestratorDeps } from './orchestrator'
import {
  emailDomainMatchesInstitution,
  buildEmailLoopChallenge,
  resolveEmailLoopClick,
  evaluateChallengeClick,
  isStaleAlumniRisk,
  makeEmailLoopProvider,
  type EmailLoopChallenge,
} from './providers/email-loop'
import { makeNscProvider } from './providers/nsc'

const NOW = new Date('2026-06-26T12:00:00Z')

const INPUT: VerificationSubscriberInput = {
  subscriberId: 'sub-1',
  tenantId: 'ten-1',
  email: 'jane@uni-stuttgart.de',
  name: 'Jane Doe',
  institutionName: 'University of Stuttgart',
  institutionCountry: 'DE',
  statedGraduationDate: '2025-07-01',
}

function activeConsent(over: Partial<ConsentRecord> = {}): ConsentRecord {
  return {
    id: 'c-1',
    scope: 'enrollment_status',
    purpose: 'continued EDU eligibility verification',
    recipient: 'National Student Clearinghouse',
    consentTextVersion: 'v0-placeholder',
    grantedAt: '2026-06-01T00:00:00Z',
    revokedAt: null,
    expiresAt: null,
    ...over,
  }
}

/** A controllable stub provider. */
function stub(
  key: string,
  methodClass: 'authoritative' | 'semi_authoritative' | 'document',
  outcome: VerificationOutcome,
  opts: { requiresConsent?: boolean; canAssertNotEnrolled?: boolean; calls?: string[] } = {},
): VerificationProvider {
  return {
    providerKey: key,
    methodClass,
    requiresConsent: opts.requiresConsent ?? false,
    canAssertNotEnrolled: opts.canAssertNotEnrolled ?? methodClass === 'authoritative',
    async verify() {
      opts.calls?.push(key)
      return makeVerificationResult(key, methodClass, outcome)
    },
  }
}

function deps(over: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    now: () => NOW,
    isApplicable: () => true,
    getActiveConsent: async () => null,
    ...over,
  }
}

// ── base.ts: asymmetry helpers ───────────────────────────────────────────────────────────────────────
describe('asymmetry helpers (Part 2.1)', () => {
  it('only NOT_ENROLLED is adverse', () => {
    expect(isAdverse(VerificationOutcome.NOT_ENROLLED)).toBe(true)
    for (const o of [
      VerificationOutcome.ENROLLED,
      VerificationOutcome.CONTROL_PROVEN,
      VerificationOutcome.UNABLE_TO_CONFIRM,
      VerificationOutcome.DOCUMENT_PENDING,
      VerificationOutcome.ERROR,
    ]) {
      expect(isAdverse(o)).toBe(false)
    }
  })

  it('terminal = enrolled/not_enrolled/control_proven/document_pending', () => {
    expect(isTerminal(VerificationOutcome.ENROLLED)).toBe(true)
    expect(isTerminal(VerificationOutcome.NOT_ENROLLED)).toBe(true)
    expect(isTerminal(VerificationOutcome.CONTROL_PROVEN)).toBe(true)
    expect(isTerminal(VerificationOutcome.DOCUMENT_PENDING)).toBe(true)
    expect(isTerminal(VerificationOutcome.UNABLE_TO_CONFIRM)).toBe(false)
    expect(isTerminal(VerificationOutcome.ERROR)).toBe(false)
  })

  it('maps terminal outcome to subscriber status', () => {
    expect(statusFromOutcome(VerificationOutcome.ENROLLED)).toBe('verified_enrolled')
    expect(statusFromOutcome(VerificationOutcome.CONTROL_PROVEN)).toBe('verified_enrolled')
    expect(statusFromOutcome(VerificationOutcome.NOT_ENROLLED)).toBe('verified_not_enrolled')
    expect(statusFromOutcome(VerificationOutcome.UNABLE_TO_CONFIRM)).toBe('unverified')
  })

  it('confidence defaults from method class; non-terminal is low', () => {
    expect(defaultConfidenceFor('authoritative', VerificationOutcome.ENROLLED)).toBe('authoritative')
    expect(defaultConfidenceFor('semi_authoritative', VerificationOutcome.CONTROL_PROVEN)).toBe('semi_authoritative')
    expect(defaultConfidenceFor('document', VerificationOutcome.DOCUMENT_PENDING)).toBe('medium')
    expect(defaultConfidenceFor('authoritative', VerificationOutcome.UNABLE_TO_CONFIRM)).toBe('low')
  })
})

// ── consent.ts ───────────────────────────────────────────────────────────────────────────────────────
describe('consent gate (Part 6.1)', () => {
  it('active only when present, not revoked, not expired', () => {
    expect(isConsentActive(null, NOW)).toBe(false)
    expect(isConsentActive(activeConsent(), NOW)).toBe(true)
    expect(isConsentActive(activeConsent({ revokedAt: '2026-06-10T00:00:00Z' }), NOW)).toBe(false)
    expect(isConsentActive(activeConsent({ expiresAt: '2026-06-20T00:00:00Z' }), NOW)).toBe(false)
    expect(isConsentActive(activeConsent({ expiresAt: '2026-12-31T00:00:00Z' }), NOW)).toBe(true)
  })

  it('non-consent provider is always allowed', () => {
    expect(checkConsentGate({ requiresConsent: false }, null, NOW)).toEqual({ allowed: true })
  })

  it('consent-required provider skipped with a reason when no/revoked/expired consent', () => {
    expect(checkConsentGate({ requiresConsent: true }, null, NOW)).toEqual({ allowed: false, reason: 'no_consent' })
    expect(checkConsentGate({ requiresConsent: true }, activeConsent({ revokedAt: '2026-06-10T00:00:00Z' }), NOW)).toEqual({
      allowed: false,
      reason: 'revoked',
    })
    expect(checkConsentGate({ requiresConsent: true }, activeConsent({ expiresAt: '2026-01-01T00:00:00Z' }), NOW)).toEqual({
      allowed: false,
      reason: 'expired',
    })
    expect(checkConsentGate({ requiresConsent: true }, activeConsent(), NOW)).toEqual({ allowed: true })
  })
})

// ── orchestrator.ts ──────────────────────────────────────────────────────────────────────────────────
describe('verification waterfall (Part 2)', () => {
  it('stops at the first terminal confirmation and reports status', async () => {
    const calls: string[] = []
    const providers = [
      stub('nsc', 'authoritative', VerificationOutcome.ENROLLED, { calls }),
      stub('email_loop', 'semi_authoritative', VerificationOutcome.CONTROL_PROVEN, { calls }),
    ]
    const out = await runVerificationWaterfall(providers, INPUT, deps())
    expect(out.winner?.outcome).toBe(VerificationOutcome.ENROLLED)
    expect(out.subscriberStatus).toBe('verified_enrolled')
    expect(calls).toEqual(['nsc']) // email_loop never ran
  })

  it('falls through unable_to_confirm to the next method', async () => {
    const calls: string[] = []
    const providers = [
      stub('nsc', 'authoritative', VerificationOutcome.UNABLE_TO_CONFIRM, { calls }),
      stub('email_loop', 'semi_authoritative', VerificationOutcome.CONTROL_PROVEN, { calls }),
    ]
    const out = await runVerificationWaterfall(providers, INPUT, deps())
    expect(calls).toEqual(['nsc', 'email_loop'])
    expect(out.winner?.providerKey).toBe('email_loop')
    expect(out.subscriberStatus).toBe('verified_enrolled')
  })

  it('skips a consent-required provider with no consent (skip, not fail) and continues', async () => {
    const calls: string[] = []
    const providers = [
      stub('nsc', 'authoritative', VerificationOutcome.NOT_ENROLLED, { requiresConsent: true, calls }),
      stub('email_loop', 'semi_authoritative', VerificationOutcome.CONTROL_PROVEN, { calls }),
    ]
    const out = await runVerificationWaterfall(providers, INPUT, deps({ getActiveConsent: async () => null }))
    expect(calls).toEqual(['email_loop']) // nsc skipped — no consent
    expect(out.attempts[0]).toMatchObject({ providerKey: 'nsc', ran: false, skipReason: 'no_consent' })
    expect(out.winner?.providerKey).toBe('email_loop')
  })

  it('runs a consent-required provider when active consent is on file', async () => {
    const calls: string[] = []
    const providers = [stub('nsc', 'authoritative', VerificationOutcome.NOT_ENROLLED, { requiresConsent: true, calls })]
    const out = await runVerificationWaterfall(providers, INPUT, deps({ getActiveConsent: async () => activeConsent() }))
    expect(calls).toEqual(['nsc'])
    expect(out.subscriberStatus).toBe('verified_not_enrolled')
  })

  it('skips a method that is not applicable', async () => {
    const calls: string[] = []
    const providers = [stub('nsc', 'authoritative', VerificationOutcome.ENROLLED, { calls })]
    const out = await runVerificationWaterfall(providers, INPUT, deps({ isApplicable: () => false }))
    expect(calls).toEqual([])
    expect(out.attempts[0]).toMatchObject({ ran: false, skipReason: 'method_not_applicable' })
    expect(out.subscriberStatus).toBe('unverified')
  })

  it('DOWNGRADES a non-authoritative NOT_ENROLLED to unable_to_confirm (safety invariant)', async () => {
    // A semi-authoritative provider must never be able to refute enrollment.
    const providers = [
      stub('email_loop', 'semi_authoritative', VerificationOutcome.NOT_ENROLLED, { canAssertNotEnrolled: false }),
    ]
    const out = await runVerificationWaterfall(providers, INPUT, deps())
    // downgraded → non-terminal → falls through → exhausted → unverified
    expect(out.attempts[0].result?.outcome).toBe(VerificationOutcome.UNABLE_TO_CONFIRM)
    expect(out.attempts[0].result?.errorMessage).toMatch(/cannot assert NOT_ENROLLED/)
    expect(out.subscriberStatus).toBe('unverified')
  })

  it('exhausted waterfall = unverified, never ineligible', async () => {
    const providers = [
      stub('nsc', 'authoritative', VerificationOutcome.UNABLE_TO_CONFIRM),
      stub('email_loop', 'semi_authoritative', VerificationOutcome.ERROR),
    ]
    const out = await runVerificationWaterfall(providers, INPUT, deps())
    expect(out.winner).toBeNull()
    expect(out.subscriberStatus).toBe('unverified')
    expect(out.confidence).toBeNull()
  })
})

// ── email-loop.ts ────────────────────────────────────────────────────────────────────────────────────
describe('email-loop provider (Part 8.1)', () => {
  it('matches institutional domain and subdomains, rejects personal email', () => {
    const domains = ['uni-stuttgart.de', 'ul.pt']
    expect(emailDomainMatchesInstitution('jane@uni-stuttgart.de', domains)).toBe(true)
    expect(emailDomainMatchesInstitution('jane@campus.ul.pt', domains)).toBe(true) // subdomain
    expect(emailDomainMatchesInstitution('jane@gmail.com', domains)).toBe(false)
    expect(emailDomainMatchesInstitution(null, domains)).toBe(false)
    expect(emailDomainMatchesInstitution('not-an-email', domains)).toBe(false)
  })

  it('builds an expiring challenge', () => {
    const c = buildEmailLoopChallenge('sub-1', 'Jane@Uni-Stuttgart.DE', { token: 'tok', now: NOW, ttlMinutes: 60 })
    expect(c.email).toBe('jane@uni-stuttgart.de')
    expect(c.token).toBe('tok')
    expect(new Date(c.expiresAt).getTime() - new Date(c.issuedAt).getTime()).toBe(60 * 60_000)
  })

  it('resolves a valid click to CONTROL_PROVEN; expired/mismatch to unable_to_confirm', () => {
    const c: EmailLoopChallenge = buildEmailLoopChallenge('sub-1', 'jane@uni-stuttgart.de', {
      token: 'tok',
      now: NOW,
      ttlMinutes: 60,
    })
    const ok = resolveEmailLoopClick(c, 'tok', new Date(NOW.getTime() + 30 * 60_000))
    expect(ok.outcome).toBe(VerificationOutcome.CONTROL_PROVEN)
    expect(ok.confidence).toBe('semi_authoritative')

    const expired = resolveEmailLoopClick(c, 'tok', new Date(NOW.getTime() + 120 * 60_000))
    expect(expired.outcome).toBe(VerificationOutcome.UNABLE_TO_CONFIRM)

    const wrong = resolveEmailLoopClick(c, 'nope', new Date(NOW.getTime() + 10 * 60_000))
    expect(wrong.outcome).toBe(VerificationOutcome.UNABLE_TO_CONFIRM)
  })

  it('flags stale-alumni false-positive risk', () => {
    expect(isStaleAlumniRisk('2020-06-01', NOW)).toBe(true)
    expect(isStaleAlumniRisk('2025-12-01', NOW)).toBe(false)
    expect(isStaleAlumniRisk(null, NOW)).toBe(false)
  })

  it('is SINGLE-USE: a consumed challenge is never replayed, even with the correct unexpired token', () => {
    const c = buildEmailLoopChallenge('sub-1', 'jane@uni-stuttgart.de', { token: 'tok', now: NOW, ttlMinutes: 60 })
    const soon = new Date(NOW.getTime() + 10 * 60_000)
    // Not yet consumed + valid token → resolves to CONTROL_PROVEN.
    const first = evaluateChallengeClick(c, null, 'tok', soon)
    expect(first.kind).toBe('resolved')
    expect(first.kind === 'resolved' && first.result.outcome).toBe(VerificationOutcome.CONTROL_PROVEN)
    // Already consumed → replay rejected regardless of a correct, unexpired token.
    const replay = evaluateChallengeClick(c, NOW.toISOString(), 'tok', soon)
    expect(replay.kind).toBe('already_used')
  })

  it('provider returns CONTROL_PROVEN only with a completed challenge', async () => {
    const challenge = buildEmailLoopChallenge('sub-1', 'jane@uni-stuttgart.de', { token: 'tok', now: NOW })
    const withClick = makeEmailLoopProvider({ now: () => NOW, getCompletedChallenge: async () => challenge })
    const r1 = await withClick.verify(INPUT, null)
    expect(r1.outcome).toBe(VerificationOutcome.CONTROL_PROVEN)

    const noClick = makeEmailLoopProvider({ now: () => NOW, getCompletedChallenge: async () => null })
    const r2 = await noClick.verify(INPUT, null)
    expect(r2.outcome).toBe(VerificationOutcome.UNABLE_TO_CONFIRM)
  })
})

// ── nsc.ts (stub) ────────────────────────────────────────────────────────────────────────────────────
describe('NSC provider stub (Part 3 / Part 10)', () => {
  it('requires consent, can assert not_enrolled, but the stub never confirms or refutes', async () => {
    const nsc = makeNscProvider()
    expect(nsc.requiresConsent).toBe(true)
    expect(nsc.canAssertNotEnrolled).toBe(true)
    const r = await nsc.verify(INPUT, activeConsent())
    expect(r.outcome).toBe(VerificationOutcome.UNABLE_TO_CONFIRM)
    expect(r.errorMessage).toMatch(/pending commercial agreement/)
  })
})
