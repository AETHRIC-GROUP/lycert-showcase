/**
 * Supabase bindings for the verification worker (worker.ts is pure over these interfaces).
 *
 * Reuses the enrichment queue runtime: the generic public.q_* wrappers (0030) operate on any queue, so
 * the verification worker uses the same readBatch/archive/toDlq over verification_q (0041). Reuses the
 * academic_domains reference set (0032) for Step-1 institution resolution. Follows the same hand-cast
 * row-mapping style as enrichment/worker-io.ts (so generated types are not a hard dependency here; a
 * `supabase gen types` regen is a clean-up follow-up once the IO stabilises).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { serviceClient } from '../enrichment/worker-io'
import { readBatch, archive as qArchive, toDlq as qToDlq, type RpcClient } from '../enrichment/queue'
import {
  type ConsentRecord,
  type MethodClass,
  type VerificationProvider,
  type VerificationResult,
  type VerificationSubscriberInput,
} from './base'
import type { EmailLoopChallenge } from './providers/email-loop'
import { makeVerificationProvider } from './providers'
import { type AcademicDomainMatch, type ProviderApplicability, type ResolvedInstitution, resolveInstitution } from './institution'
import { institutionDomainCandidates } from './institution'
import type { SubscriberVerificationPatch, VerificationJobMsg, VerificationWorkerIO } from './worker'

export const VERIFICATION_QUEUES = {
  verification: 'verification_q',
  verificationDlq: 'verification_dlq',
} as const

const RESULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000 // Part 6.2 default (decision + appeal window)

type Row = Record<string, unknown>

export function makeVerificationIO(db: SupabaseClient = serviceClient()): VerificationWorkerIO {
  const rpc = db as unknown as RpcClient
  // Provider availability metadata (country_scope), cached per worker invocation.
  const metaCache = new Map<string, ProviderApplicability>()

  async function lookupAcademicDomain(candidates: string[]): Promise<AcademicDomainMatch | null> {
    if (!candidates.length) return null
    const { data } = await db
      .from('academic_domains')
      .select('domain, name, country')
      .in('domain', candidates)
    const rows = (data ?? []) as unknown as Row[]
    if (!rows.length) return null
    // Most-specific (longest domain) match wins, matching the enrichment longest-match rule.
    rows.sort((a, b) => String(b.domain).length - String(a.domain).length)
    const r = rows[0]
    return { domain: String(r.domain), name: String(r.name ?? ''), country: (r.country as string) ?? null }
  }

  async function getCompletedChallenge(subscriberId: string): Promise<EmailLoopChallenge | null> {
    const { data } = await db
      .from('verification_challenges')
      .select('subscriber_id, email, token, issued_at, expires_at')
      .eq('subscriber_id', subscriberId)
      .eq('outcome', 'control_proven')
      .not('consumed_at', 'is', null)
      .order('consumed_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!data) return null
    const r = data as unknown as Row
    return {
      subscriberId: String(r.subscriber_id),
      email: String(r.email),
      token: String(r.token),
      issuedAt: String(r.issued_at),
      expiresAt: String(r.expires_at),
    }
  }

  return {
    async readChunk(qty, vt) {
      return readBatch<VerificationJobMsg>(rpc, VERIFICATION_QUEUES.verification, qty, vt)
    },
    archive: (msgId) => qArchive(rpc, VERIFICATION_QUEUES.verification, msgId),
    toDlq: (msgId, message) =>
      qToDlq(rpc, VERIFICATION_QUEUES.verification, VERIFICATION_QUEUES.verificationDlq, msgId, message),

    async loadSubscriberInput(subscriberId, tenantId): Promise<VerificationSubscriberInput | null> {
      const { data } = await db
        .from('subscribers')
        .select('id, email, name, institution_name, stated_graduation_date')
        .eq('id', subscriberId)
        .eq('tenant_id', tenantId)
        .maybeSingle()
      if (!data) return null
      const r = data as unknown as Row
      return {
        subscriberId: String(r.id),
        tenantId,
        email: (r.email as string | null) ?? null,
        name: (r.name as string | null) ?? null,
        institutionName: (r.institution_name as string | null) ?? null,
        // ISO country is resolved from the academic_domains match (Step 1); the subscriber row stores a
        // country NAME, not an ISO code, so we don't seed it here — the resolver fills it from the domain.
        institutionCountry: null,
        statedGraduationDate: (r.stated_graduation_date as string | null) ?? null,
      }
    },

    async loadProviders(_tenantId): Promise<VerificationProvider[]> {
      const { data } = await db
        .from('verification_providers')
        .select('provider_key, method_class, country_scope, enabled, default_position')
        .eq('enabled', true)
        .order('default_position', { ascending: true })
      const rows = (data ?? []) as unknown as Row[]
      const providers: VerificationProvider[] = []
      for (const r of rows) {
        const key = String(r.provider_key)
        metaCache.set(key, {
          providerKey: key,
          methodClass: r.method_class as MethodClass,
          countryScope: (r.country_scope as string[] | null) ?? null,
        })
        const provider = makeVerificationProvider(key, { now: () => new Date(), getCompletedChallenge })
        if (provider) providers.push(provider)
      }
      return providers
    },

    async resolveInstitution(input): Promise<ResolvedInstitution> {
      return resolveInstitution(input, { lookupAcademicDomain })
    },

    providerMeta(providerKey) {
      return metaCache.get(providerKey) ?? null
    },

    async getActiveConsent(_provider, input): Promise<ConsentRecord | null> {
      const nowIso = new Date().toISOString()
      const { data } = await db
        .from('verification_consents')
        .select('id, scope, purpose, recipient, consent_text_version, granted_at, revoked_at, expires_at')
        .eq('subscriber_id', input.subscriberId)
        .eq('tenant_id', input.tenantId)
        .is('revoked_at', null)
        .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
        .order('granted_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (!data) return null
      const r = data as unknown as Row
      return {
        id: String(r.id),
        scope: String(r.scope),
        purpose: String(r.purpose),
        recipient: String(r.recipient),
        consentTextVersion: String(r.consent_text_version),
        grantedAt: String(r.granted_at),
        revokedAt: (r.revoked_at as string | null) ?? null,
        expiresAt: (r.expires_at as string | null) ?? null,
      }
    },

    async persistResult(subscriberId, tenantId, result: VerificationResult, now: Date) {
      const { error } = await db.from('verification_results').insert({
        tenant_id: tenantId,
        subscriber_id: subscriberId,
        provider_key: result.providerKey,
        method_class: result.methodClass,
        status: result.outcome, // enum values are identical to the DB status strings (base.ts)
        confidence: result.confidence,
        enrollment_status: result.enrollmentStatus,
        enrollment_end_date: result.enrollmentEndDate,
        as_of_date: result.asOfDate,
        consent_id: result.consentId,
        raw_reference: result.rawReference, // provider request id ONLY — never a PII payload (Part 6.2)
        checked_at: now.toISOString(),
        delete_at: new Date(now.getTime() + RESULT_RETENTION_MS).toISOString(),
      })
      if (error) throw new Error(`persistResult: ${error.message}`)
    },

    async updateSubscriber(subscriberId, tenantId, patch: SubscriberVerificationPatch) {
      const { error } = await db
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
      if (error) throw new Error(`updateSubscriber: ${error.message}`)
    },

    now: () => new Date(),
  }
}

// Re-export so callers can construct an independent client if needed (mirrors enrichment-io).
export { createClient }
