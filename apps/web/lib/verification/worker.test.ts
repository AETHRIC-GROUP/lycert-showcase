/**
 * Verification queue worker — patch derivation (incl. the stale-alumni elevated-review guard, Part 8.1)
 * and the chunk drain/DLQ contract (Part 9.2 step 6).
 */
import { describe, it, expect } from 'vitest'
import {
  patchFromOutcome,
  processVerificationChunk,
  VERIFICATION_MAX_READ_CT,
  type VerificationJobMsg,
  type VerificationWorkerIO,
} from './worker'
import {
  VerificationOutcome,
  makeVerificationResult,
  type VerificationProvider,
  type VerificationResult,
  type VerificationSubscriberInput,
} from './base'
import type { WaterfallOutcome } from './orchestrator'

const NOW = new Date('2026-06-29T12:00:00Z')
const input = (over: Partial<VerificationSubscriberInput> = {}): VerificationSubscriberInput => ({
  subscriberId: 's1', tenantId: 't1', email: 'jane@uni.edu', name: 'Jane',
  institutionName: 'Uni', institutionCountry: 'US', statedGraduationDate: '2025-06-01', ...over,
})

function outcome(winner: VerificationResult | null, status: WaterfallOutcome['subscriberStatus']): WaterfallOutcome {
  return { winner, attempts: winner ? [{ providerKey: winner.providerKey, ran: true, result: winner }] : [], subscriberStatus: status, confidence: winner?.confidence ?? null }
}

describe('patchFromOutcome (Part 8.1 stale-alumni guard + re-verify cadence)', () => {
  it('no winner → null (leave stored status UNTOUCHED, never clobber re-verification)', () => {
    expect(patchFromOutcome(outcome(null, 'unverified'), input(), NOW)).toBeNull()
  })

  it('authoritative ENROLLED → verified_enrolled with a 180-day re-verify window', () => {
    const w = makeVerificationResult('nsc', 'authoritative', VerificationOutcome.ENROLLED)
    const p = patchFromOutcome(outcome(w, 'verified_enrolled'), input(), NOW)!
    expect(p.status).toBe('verified_enrolled')
    expect(p.method).toBe('nsc')
    const days = (new Date(p.verificationExpiresAt!).getTime() - NOW.getTime()) / 86_400_000
    expect(Math.round(days)).toBe(180)
  })

  it('email-loop control on a RECENT grad → verified_enrolled (90-day window)', () => {
    const w = makeVerificationResult('email_loop', 'semi_authoritative', VerificationOutcome.CONTROL_PROVEN)
    const p = patchFromOutcome(outcome(w, 'verified_enrolled'), input({ statedGraduationDate: '2025-06-01' }), NOW)!
    expect(p.status).toBe('verified_enrolled')
    const days = (new Date(p.verificationExpiresAt!).getTime() - NOW.getTime()) / 86_400_000
    expect(Math.round(days)).toBe(90)
  })

  it('email-loop control on a LONG-graduated subscriber → null (alumni inbox must not clear them)', () => {
    const w = makeVerificationResult('email_loop', 'semi_authoritative', VerificationOutcome.CONTROL_PROVEN)
    const p = patchFromOutcome(outcome(w, 'verified_enrolled'), input({ statedGraduationDate: '2018-06-01' }), NOW)
    expect(p).toBeNull()
  })
})

describe('processVerificationChunk does not clobber a verified subscriber on a no-confirmation run', () => {
  it('archives without calling updateSubscriber when the run yields no terminal winner', async () => {
    // A re-verification run where the only provider returns unable_to_confirm (e.g. expired challenge).
    const noWinnerProvider: VerificationProvider = {
      providerKey: 'email_loop', methodClass: 'semi_authoritative', requiresConsent: false, canAssertNotEnrolled: false,
      async verify() { return makeVerificationResult('email_loop', 'semi_authoritative', VerificationOutcome.UNABLE_TO_CONFIRM) },
    }
    const h = fakeIO({
      msgs: [{ msgId: 5, readCt: 1, message: { subscriberId: 's1', tenantId: 't1' } }],
      loadProviders: async () => [noWinnerProvider],
    })
    const r = await processVerificationChunk(h.io)
    expect(r.processed).toBe(1)
    expect(h.updated).toHaveLength(0) // stored status left UNTOUCHED — re-verification is non-destructive
    expect(h.archived).toEqual([5])
  })
})

// ── chunk drain ──────────────────────────────────────────────────────────────────
function authProvider(out: VerificationOutcome): VerificationProvider {
  return {
    providerKey: 'nsc', methodClass: 'authoritative', requiresConsent: false, canAssertNotEnrolled: true,
    async verify() { return makeVerificationResult('nsc', 'authoritative', out) },
  }
}

function fakeIO(over: Partial<VerificationWorkerIO> & { msgs: Array<{ msgId: number; readCt: number; message: VerificationJobMsg }> }): {
  io: VerificationWorkerIO; persisted: VerificationResult[]; updated: unknown[]; archived: number[]; dlq: number[]
} {
  const persisted: VerificationResult[] = []
  const updated: unknown[] = []
  const archived: number[] = []
  const dlq: number[] = []
  let read = false
  const io: VerificationWorkerIO = {
    async readChunk() { if (read) return []; read = true; return over.msgs },
    async archive(id) { archived.push(id) },
    async toDlq(id) { dlq.push(id) },
    async loadSubscriberInput() { return input() },
    async loadProviders() { return [authProvider(VerificationOutcome.ENROLLED)] },
    async resolveInstitution() { return { country: 'US', knownDomains: ['uni.edu'], nscParticipating: null, ssoCapable: null } },
    providerMeta() { return { providerKey: 'nsc', methodClass: 'authoritative', countryScope: ['US'] } },
    async getActiveConsent() { return null },
    async persistResult(_s, _t, r) { persisted.push(r) },
    async updateSubscriber(_s, _t, patch) { updated.push(patch) },
    now: () => NOW,
    ...over,
  }
  return { io, persisted, updated, archived, dlq }
}

describe('processVerificationChunk', () => {
  it('runs the waterfall, persists the result, updates status, and archives', async () => {
    const h = fakeIO({ msgs: [{ msgId: 1, readCt: 1, message: { subscriberId: 's1', tenantId: 't1' } }] })
    const r = await processVerificationChunk(h.io)
    expect(r.processed).toBe(1)
    expect(h.persisted).toHaveLength(1)
    expect(h.persisted[0].outcome).toBe(VerificationOutcome.ENROLLED)
    expect((h.updated[0] as { status: string }).status).toBe('verified_enrolled')
    expect(h.archived).toEqual([1])
  })

  it('routes a poison message (read_ct over the cap) to the DLQ without re-running', async () => {
    const h = fakeIO({ msgs: [{ msgId: 9, readCt: VERIFICATION_MAX_READ_CT + 1, message: { subscriberId: 's1', tenantId: 't1' } }] })
    const r = await processVerificationChunk(h.io)
    expect(r.dlq).toBe(1)
    expect(h.dlq).toEqual([9])
    expect(h.persisted).toHaveLength(0)
  })

  it('archives (does not retry forever) when the subscriber no longer exists', async () => {
    const h = fakeIO({ msgs: [{ msgId: 2, readCt: 1, message: { subscriberId: 'gone', tenantId: 't1' } }], loadSubscriberInput: async () => null })
    const r = await processVerificationChunk(h.io)
    expect(r.processed).toBe(1)
    expect(h.archived).toEqual([2])
  })
})
