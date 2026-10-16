/**
 * Mailer for the email-loop live path (Part 8.1).
 *
 * SAFETY (these are real students): a real email can only be sent when BOTH
 *   - LYCERT_RESEND_API_KEY is set, AND
 *   - LYCERT_EMAIL_LOOP_ENABLED === 'true'
 * Otherwise `makeVerificationMailer()` returns null and the issue path sends nothing (and persists no
 * challenge). On staging the Resend key is the sandbox key (emails never leave Resend). There is no cron
 * or batch auto-send — issuing is always an explicit owner/admin action (POST /api/verification/email-loop/send).
 */

export interface VerificationMailer {
  /** Send the one-time email-loop verification link to the subscriber's institutional address. */
  sendEmailLoopLink(args: { to: string; link: string; institutionName: string | null; clientName: string }): Promise<void>
}

/** Logs the link instead of sending — local dev / tests only. */
export const consoleMailer: VerificationMailer = {
  async sendEmailLoopLink({ to, link }) {
    console.log('[verification/mailer:console] would send email-loop link to %s: %s', to, link)
  },
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails'

/** Minimal Resend client (POST /emails). `from` must be a verified Resend sender domain. */
export class ResendMailer implements VerificationMailer {
  constructor(private apiKey: string, private from: string) {}
  async sendEmailLoopLink({ to, link, institutionName, clientName }: { to: string; link: string; institutionName: string | null; clientName: string }): Promise<void> {
    const subject = `Confirm your student status for ${clientName}`
    const where = institutionName ? ` at ${institutionName}` : ''
    const html =
      `<div style="font-family:system-ui,sans-serif;max-width:32rem">` +
      `<p>${clientName} offers special student pricing. To keep it, please confirm you are currently enrolled${where} by clicking the secure link below from this email account.</p>` +
      `<p><a href="${link}" style="display:inline-block;background:#2563eb;color:#fff;padding:.6rem 1rem;border-radius:8px;text-decoration:none">Confirm my enrollment</a></p>` +
      `<p style="color:#64748b;font-size:.85rem">This link is single-use and expires in 24 hours. If you did not expect this, you can ignore it.</p></div>`
    const resp = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: this.from, to: [to], subject, html }),
    })
    if (!resp.ok) throw new Error(`resend ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
  }
}

/**
 * Resolve the active mailer, or null when sending is not fully enabled (the default). Both env gates must
 * be present — a stray key alone never enables sends. Does not throw.
 */
export function makeVerificationMailer(): VerificationMailer | null {
  const key = process.env.LYCERT_RESEND_API_KEY
  const enabled = process.env.LYCERT_EMAIL_LOOP_ENABLED === 'true'
  if (!key || !enabled) {
    if (key && !enabled) console.warn('[verification/mailer] LYCERT_RESEND_API_KEY set but LYCERT_EMAIL_LOOP_ENABLED!=true — email-loop send stays OFF')
    return null
  }
  const from = process.env.LYCERT_VERIFY_FROM_EMAIL || 'Lycert <verify@lycert.com>'
  return new ResendMailer(key, from)
}
