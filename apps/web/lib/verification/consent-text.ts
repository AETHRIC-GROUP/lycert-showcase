/**
 * Consent text + the five FERPA fields (Part 6.1) for the hosted re-verification flow.
 *
 * ⚠ DRAFT — NOT legally reviewed (Part 9.1.2). The `version` string is suffixed `-draft` precisely so a
 * consent captured against it is identifiable and can be re-collected once counsel signs off. No
 * `requires_consent` provider runs live until the text is approved AND the provider is enabled — this
 * module only supplies what the page renders and what the consent row stores. Source draft:
 * docs/VERIFICATION_CONSENT_DRAFT.md.
 */

export const CONSENT_TEXT_VERSION = 'ferpa-v1-2026-06-draft'

export interface ConsentContext {
  clientName: string // the tenant / software company offering the student program
  supportEmail?: string
  expiresAt?: string // ISO; shown to the subscriber
}

/** The five FERPA fields stored on the consent row (scope/purpose/recipient + version + dated-on-grant). */
export function consentFields(ctx: ConsentContext) {
  return {
    scope: 'enrollment_status',
    purpose: `continued EDU eligibility verification for ${ctx.clientName}`,
    recipient: 'National Student Clearinghouse and/or your educational institution',
    consentTextVersion: CONSENT_TEXT_VERSION,
  }
}

/** Human-readable consent screen blocks (rendered on the hosted page). */
export function consentScreen(ctx: ConsentContext) {
  const expiry = ctx.expiresAt ? new Date(ctx.expiresAt).toISOString().slice(0, 10) : null
  return {
    heading: 'Confirm your student status',
    intro:
      `${ctx.clientName} offers special student pricing. To keep it, we need to confirm that you are ` +
      `currently enrolled at your school. Lycert performs this check on behalf of ${ctx.clientName}.`,
    bullets: [
      { label: 'What will be checked', text: 'Your current enrollment status (whether you are currently enrolled, and your enrollment dates). We do not request or receive your grades, transcripts, or courses.' },
      { label: 'Who will check it', text: `Lycert (operated by Aethric Group LLC), acting for ${ctx.clientName}, by sending a verification request to the National Student Clearinghouse and/or your educational institution.` },
      { label: 'Why', text: `Solely to confirm your continued eligibility for ${ctx.clientName}'s student program.` },
      { label: 'What we keep', text: 'Only the result (enrolled / not enrolled / unable to confirm) and the date it was confirmed — never the underlying records.' },
      { label: 'Your rights', text: `This authorization is voluntary and you may withdraw it at any time${ctx.supportEmail ? ` by contacting ${ctx.supportEmail}` : ''}.${expiry ? ` It expires on ${expiry}.` : ''}` },
    ],
    affirmation: 'I authorize this enrollment verification. I confirm I am the person named below.',
    draftNotice: 'This consent wording is pending final legal review.',
  }
}
