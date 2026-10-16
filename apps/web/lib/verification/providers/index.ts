/**
 * Verification provider factory — maps a provider_key (from verification_providers) to its
 * VerificationProvider implementation. Mirrors enrichment's makeProvider().
 *
 * Gated authoritative sources (nsc/hedd) are STUBS until their commercial agreements land; document
 * is a stub until the OCR pipeline exists; sso has no class yet (returns null — it stays a disabled
 * seed row only). Unknown keys → null, so the IO layer simply skips them.
 */

import type { VerificationProvider } from '../base'
import type { EmailLoopChallenge } from './email-loop'
import { makeEmailLoopProvider } from './email-loop'
import { makeNscProvider } from './nsc'
import { makeHeddProvider } from './hedd'
import { makeDocumentProvider } from './document'

export interface VerificationProviderDeps {
  now: () => Date
  /** Email-loop: load a completed (clicked, unexpired) challenge for the subscriber, or null. */
  getCompletedChallenge: (subscriberId: string) => Promise<EmailLoopChallenge | null>
}

export function makeVerificationProvider(
  key: string,
  deps: VerificationProviderDeps,
): VerificationProvider | null {
  switch (key) {
    case 'email_loop':
      return makeEmailLoopProvider({ now: deps.now, getCompletedChallenge: deps.getCompletedChallenge })
    case 'nsc':
      return makeNscProvider()
    case 'hedd':
      return makeHeddProvider()
    case 'document':
      return makeDocumentProvider()
    case 'sso':
      return null // no class yet — disabled seed row only (Part 8.2; built later)
    default:
      return null
  }
}
