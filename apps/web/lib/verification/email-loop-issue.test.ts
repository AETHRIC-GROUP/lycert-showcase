/**
 * Email-loop ISSUE path (Part 8.1): eligibility + the send-safety gate.
 */
import { describe, it, expect, vi } from 'vitest'
import { issueEmailLoopChallenge, clickLink, type EmailLoopIssueDeps } from './email-loop-issue'
import type { VerificationMailer } from './mailer'

const NOW = new Date('2026-06-29T12:00:00Z')

function deps(over: Partial<EmailLoopIssueDeps> = {}): { d: EmailLoopIssueDeps; persisted: unknown[]; sent: unknown[] } {
  const persisted: unknown[] = []
  const sent: unknown[] = []
  const mailer: VerificationMailer = { async sendEmailLoopLink(a) { sent.push(a) } }
  const d: EmailLoopIssueDeps = {
    now: () => NOW,
    genToken: () => 'tok-123',
    mailer,
    baseUrl: 'https://verify.lycert.com',
    clientName: 'Acme Software',
    loadSubscriber: async () => ({ email: 'jane@uni.edu', name: 'Jane', institutionName: 'Uni' }),
    resolveInstitutionDomains: async () => ['uni.edu'],
    persistChallenge: async (c) => { persisted.push(c) },
    ...over,
  }
  return { d, persisted, sent }
}

describe('issueEmailLoopChallenge', () => {
  it('institutional email + mailer on → persists a challenge and sends the click link', async () => {
    const { d, persisted, sent } = deps()
    const r = await issueEmailLoopChallenge('s1', 't1', d)
    expect(r).toEqual({ sent: true, reason: 'sent' })
    expect(persisted).toHaveLength(1)
    expect((sent[0] as { link: string }).link).toBe(clickLink('https://verify.lycert.com', 'tok-123'))
    expect((sent[0] as { to: string }).to).toBe('jane@uni.edu')
  })

  it('SAFETY: mailer off → nothing persisted, nothing sent', async () => {
    const { d, persisted, sent } = deps({ mailer: null })
    const r = await issueEmailLoopChallenge('s1', 't1', d)
    expect(r).toEqual({ sent: false, reason: 'mailer_disabled' })
    expect(persisted).toEqual([])
    expect(sent).toEqual([])
  })

  it('personal email (not institutional) → never emailed, nothing persisted', async () => {
    const { d, persisted, sent } = deps({ loadSubscriber: async () => ({ email: 'jane@gmail.com', name: 'Jane', institutionName: 'Uni' }) })
    const r = await issueEmailLoopChallenge('s1', 't1', d)
    expect(r).toEqual({ sent: false, reason: 'not_institutional_email' })
    expect(persisted).toEqual([])
    expect(sent).toEqual([])
  })

  it('missing subscriber / missing email handled', async () => {
    const noSub = await issueEmailLoopChallenge('s1', 't1', deps({ loadSubscriber: async () => null }).d)
    expect(noSub.reason).toBe('subscriber_not_found')
    const noEmail = await issueEmailLoopChallenge('s1', 't1', deps({ loadSubscriber: async () => ({ email: null, name: 'X', institutionName: 'Uni' }) }).d)
    expect(noEmail.reason).toBe('no_email')
  })

  it('does not contact a personal email even if the resolver returned no domains', async () => {
    const send = vi.fn()
    const { d } = deps({ resolveInstitutionDomains: async () => [], mailer: { sendEmailLoopLink: send } })
    const r = await issueEmailLoopChallenge('s1', 't1', d)
    expect(r.reason).toBe('not_institutional_email')
    expect(send).not.toHaveBeenCalled()
  })
})
